var _ = require('lodash');

var Service, Characteristic;
var rgb = require('hsv-rgb');

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-bluetooth-tag-lax', 'Bluetooth Tag', TagAccessory);
};

function TagAccessory(log, config) {
  this.log = log;

  this.address = config.address;
  this.type = config.type;

	this.hue = 0;
	this.saturation = 0;
	this.brightness = 0;

	this.rgb = [0,0,0];

	this.connected = false;

  this.noble = require('@abandonware/noble');
//  this.noble = require('@abandonware/noble/with-custom-binding')({extended: true});
  this.log( "watch for state change");
  this.noble.on('stateChange', this.onStateChange.bind(this));
  this.noble.on('discover', this.onDiscoverPeripheral.bind(this));

  this.presses = -1;
	this.lastButton = -1;
	this.lastBattery = -1;
}

// UART service for holyiot devices
TagAccessory.UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'.replaceAll('-', '').toLowerCase()
TagAccessory.UART_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'.replaceAll('-', '').toLowerCase()     // 'write'/'writeWithoutResponse'
TagAccessory.UART_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'.replaceAll('-', '').toLowerCase()     // 'notify' ('indicate' on micro:bit)

// SAM Labs services
TagAccessory.SAMLABS_BATTERY_SERVICE_UUID = '180f'
TagAccessory.SAMLABS_BATTERY_UUID = '2a19'
TagAccessory.SAMLABS_DATA_SERVICE_UUID = '3B989460-975F-11E4-A9FB-0002A5D5C51B'.replaceAll('-', '').toLowerCase()
TagAccessory.SAMLABS_INDICATOR_UUID = '5BAAB0A0-980C-11E4-B5E9-0002A5D5C51B'.replaceAll('-', '').toLowerCase()
TagAccessory.SAMLABS_LIGHTLEVEL_UUID = '4C592E60-980C-11E4-959A-0002A5D5C51B'.replaceAll('-', '').toLowerCase()
TagAccessory.SAMLABS_LEDOUTPUT_UUID = '84fc1520-980c-11e4-8bed-0002a5d5c51b'.replaceAll('-', '').toLowerCase()

TagAccessory.prototype.getServices = function() {

  this.batteryService = new Service.Battery();
  if( this.type == "switch" || this.type == "holyiot") {
    this.switchService = new Service.StatelessProgrammableSwitch();
    return [this.switchService, this.batteryService];
  }
  else if( this.type == "samlabs-ldr") {
    this.lightSensorService = new Service.LightSensor();
    return [this.lightSensorService, this.batteryService];
  }
  else if( this.type == "samlabs-led") {
    this.lightbulbService = new Service.Lightbulb();
    return [this.lightbulbService, this.batteryService];
  }

};

TagAccessory.prototype.onStateChange = function(state) {
  this.log( "state change to" + state);
  if (state == 'poweredOn') {
    this.log( "state change to poweredOn");
    this.discoverTag();
  }
};

TagAccessory.prototype.discoverTag = function() {
  this.log('scanning');
  this.noble.startScanning([], false); // todo true for duplicates for only beacon using advertisement for sensor data?
};

TagAccessory.prototype.onDiscoverPeripheral = function(peripheral) {
  var address = peripheral.id;
  if (address == 'unknown') {
    address = peripheral.id;
  }

  //this.log( peripheral.address + ' ' + peripheral.id);
  var canRegister = !this.address || address == this.address;
  // this.log((canRegister ? 'connecting' : 'ignoring') + ' ' + peripheral.advertisement.localName + ' (' + address + ')');
  if (!canRegister) return;
  this.log( "Manufacturer data: " + peripheral.advertisement.manufacturerData.toString('hex'));
  //this.log( "Service data: " + peripheral.advertisement.serviceData[0].data.toString('hex'));

  this.peripheral = peripheral;


  if( this.type == "switch" || this.type == "holyiot" || this.type == "samlabs-ldr" || this.type == "samlabs-led") {
		this.noble.stopScanning();
		this.peripheral.once('disconnect', this.onDisconnect.bind(this));
		this.peripheral.connect(this.onConnect.bind(this));
  }
  else if( this.type == "beacon") {
  	// report battery value
  	var battery = peripheral.advertisement.serviceData[0].data.readInt8(1);
  	var button = peripheral.advertisement.serviceData[0].data.readInt8(11);
		if( (battery != this.lastBattery) || (button != this.lastButton)) {
			//this.log( "Button: " + button);
			//this.log( "Battery: " + battery);
			var characteristic = this.batteryService.getCharacteristic(Characteristic.BatteryLevel);
			characteristic.setValue(battery);
			characteristic = this.batteryService.getCharacteristic(Characteristic.StatusLowBattery);
			characteristic.setValue((battery < 80) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

			// register keypress
			if( button) {
				this.onKeyPress();
			}

			this.lastButton = button;
			this.lastBattery = battery;
		}
	}
};

TagAccessory.prototype.onConnect = function(error) {
  if (error) { //  && error.toString().indexOf( 'already connected') < 0) {
    this.log('failed to connect: ' + error);
    this.discoverTag();
    return;
  }

	this.connected = true;
  this.log('connected');
  this.log('ready to discover services');
  this.peripheral.discoverAllServicesAndCharacteristics(this.onDiscoverServicesAndCharacteristics.bind(this));
};

TagAccessory.prototype.onDisconnect = function(error) {
  this.log('disconnected');
	this.connected = false;
  this.peripheral = null;
  this.discoverTag();
};

TagAccessory.prototype.onDiscoverServicesAndCharacteristics = function(error, services, characteristics) {
	this.log( "discovered services");
  if (error) {
    this.log('failed to discover characteristics: ' + error);
    return;
  }

  characteristics = _.keyBy(characteristics, function(characteristic) {
    return (characteristic._serviceUuid + ':' + characteristic.uuid).toLowerCase();
  });


  if( this.type == "switch") {
		this.alertCharacteristic = characteristics['1802:2a06'];

		this.keyPressCharacteristic = characteristics['ffe0:ffe1'];
		if (!this.keyPressCharacteristic) {
			this.log('could not find key press characteristic');
		} else {
			this.keyPressCharacteristic.on('data', this.onKeyPress.bind(this));
			this.keyPressCharacteristic.subscribe(function (error) {
				if (error) {
					this.log('failed to subscribe to key presses');
				} else {
					this.log('subscribed to key presses');
				}
			}.bind(this));
		}
	}
	else if( this.type == "holyiot") {
		this.readCharacteristic = characteristics[TagAccessory.UART_SERVICE_UUID + ':' + TagAccessory.UART_TX_UUID ];
		this.writeCharacteristic = characteristics[TagAccessory.UART_SERVICE_UUID + ':' + TagAccessory.UART_RX_UUID ];

		if (!this.readCharacteristic) {
			this.log('could not find read characteristic');
		} else {
			this.readCharacteristic.on('read', this.onRead.bind(this))
			this.readCharacteristic.notify(true)
			this.readCharacteristic.subscribe(function (error) {
				if (error) {
					this.log('failed to subscribe to uart read');
				} else {
					this.log('subscribed to uart read');
				}
			}.bind(this));
		}
		if (!this.writeCharacteristic) {
			this.log('could not find write characteristic');
		} else {
			this.log('writing key to device');
			this.writeCharacteristic.write( new Buffer( [0xF3, 0x00, 0xF3, 0x06, 0xAA, 0x14, 0x06, 0x11, 0x12, 0x00]), true) // writeWithoutResponse
			this.log('wrote key to device');
			this.requestBattery();
		}
	}
	else if( this.type == "samlabs-ldr" || this.type == 'samlabs-led') {
		this.batteryCharacteristic = characteristics[TagAccessory.SAMLABS_BATTERY_SERVICE_UUID + ':' + TagAccessory.SAMLABS_BATTERY_UUID];
		this.indicatorCharacteristic = characteristics[TagAccessory.SAMLABS_DATA_SERVICE_UUID + ':' + TagAccessory.SAMLABS_INDICATOR_UUID];

		if (!this.batteryCharacteristic) {
			this.log('could not find battery characteristic');
		} else {
			this.batteryCharacteristic.on('read', this.onSAMLabsBatteryRead.bind(this))
			this.batteryCharacteristic.notify(true)
			this.batteryCharacteristic.subscribe(function (error) {
				if (error) {
					this.log('failed to subscribe to samlabs battery read');
				} else {
					this.log('subscribed to samlabs battery read');
				}
			}.bind(this));
		}

		if (!this.indicatorCharacteristic) {
			this.log('could not find indicator characteristic');
		} else {
			this.log('writing color to device');
			this.indicatorCharacteristic.write( new Buffer( [0x00, 0x0a, 0x00]), false) // writeWithoutResponse
			this.log('wrote color to device');
		}

		if( this.type == "samlabs-ldr") {
			this.lightLevelCharacteristic = characteristics[TagAccessory.SAMLABS_DATA_SERVICE_UUID + ':' + TagAccessory.SAMLABS_LIGHTLEVEL_UUID];
			if (!this.lightLevelCharacteristic) {
				this.log('could not find lightLevel characteristic');
			} else {
				this.lightLevelCharacteristic.on('read', this.onSAMLabsLightLevelRead.bind(this))
				this.lightLevelCharacteristic.notify(true)
				this.lightLevelCharacteristic.subscribe(function (error) {
					if (error) {
						this.log('failed to subscribe to samlabs light level read');
					} else {
						this.log('subscribed to samlabs light level read');
					}
				}.bind(this));
			}
		}

		if( this.type == "samlabs-led") {
			this.ledCharacteristic = characteristics[TagAccessory.SAMLABS_DATA_SERVICE_UUID + ':' + TagAccessory.SAMLABS_LEDOUTPUT_UUID];
			if (!this.ledCharacteristic) {
				this.log('could not find led characteristic');
			}
			else {
				this.log('setting onSet callbacks');
				this.lightbulbService.getCharacteristic(Characteristic.On)
        .onSet(this.handleOnSet.bind(this));
				this.log('set On callback');
				this.lightbulbService.getCharacteristic(Characteristic.Hue)
        .onSet(this.handleHueSet.bind(this));
				this.log('set Hue callback');
				this.lightbulbService.getCharacteristic(Characteristic.Saturation)
        .onSet(this.handleSaturationSet.bind(this));
				this.log('set Saturation callback');
				this.lightbulbService.getCharacteristic(Characteristic.Brightness)
        .onSet(this.handleBrightnessSet.bind(this));
				this.log('set Brightness callback');
			}
		}
	}
};

// TODO: make a common method to update an rgb array based on saved h, s, v
// Then set a timeout after each of these updates and cancel the timeout if another set comes in and then when it finally
// completes write the rgb to the peripheral

TagAccessory.prototype.updateLED = function( value) {
	// TODO: sned the current rgb value to the device, or 0 if the state is not on
	this.rgb = rgb( this.hue, this.saturation, this.brightness);
  if( this.on) {
		this.ledCharacteristic.write( Buffer.from( this.rgb), false);
	} else {
		this.ledCharacteristic.write( Buffer.from( [0,0,0]), false);
	}
}

TagAccessory.prototype.handleOnSet = function( value) {
    this.log.debug('Triggered SET On:' + value);
		this.on = value;
		// TODO - for On false, have 0,0,0 sent to device
		// for On true, have whatever calculate rgb sent to device
		clearTimeout(this.ledTimeout)
		this.ledTimeout = setTimeout( this.updateLED.bind(this), 200);
}

TagAccessory.prototype.handleHueSet = function( value) {
    this.log.debug('Triggered SET Hue:' + value);
		this.hue = value;
		clearTimeout(this.ledTimeout)
		this.ledTimeout = setTimeout( this.updateLED.bind(this), 200);
		this.ledCharacteristic.write( new Buffer( [0x00, 0x00, 0x0a]), false);
}

TagAccessory.prototype.handleSaturationSet = function( value) {
    this.log.debug('Triggered SET Saturation:' + value);
		this.saturation = value;
		clearTimeout(this.ledTimeout)
		this.ledTimeout = setTimeout( this.updateLED.bind(this), 200);
		this.ledCharacteristic.write( new Buffer( [0x00, 0x00, 0x0a]), false);
}

TagAccessory.prototype.handleBrightnessSet = function( value) {
    this.log.debug('Triggered SET Brightness:' + value);
		this.brightness = value;
		clearTimeout(this.ledTimeout)
		this.ledTimeout = setTimeout( this.updateLED.bind(this), 200);
		this.ledCharacteristic.write( new Buffer( [0x00, 0x00, 0x0a]), false);
}

TagAccessory.prototype.onSAMLabsLightLevelRead = function( data, notification) {
	this.log( data[0])
	var characteristic = this.lightSensorService.getCharacteristic(Characteristic.CurrentAmbientLightLevel);
	characteristic.setValue(0xff - data[0] + .001);
}

TagAccessory.prototype.onSAMLabsBatteryRead = function( data, notification) {
	// callback from battery service on the device
	this.log( data)
	var battery = data[0];
	this.log( 'got battery: ' + battery);
	var characteristic = this.batteryService.getCharacteristic(Characteristic.BatteryLevel);
	characteristic.setValue(battery);
	characteristic = this.batteryService.getCharacteristic(Characteristic.StatusLowBattery);
	characteristic.setValue((battery < 30) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
}

TagAccessory.prototype.onRead = function( data, notification) {
	// read from uart and process battery value to homekit battery service or button state to homekit switch service
	this.log( data)
	if( data[1] == 0x15) { // button state
		if( data[4] == 0x01) {
			this.onKeyPress();
			this.requestBattery();
			this.log( 'got button: ' + data[4]);
		}
	} else if( data[1] == 0x16) { // battery percentage
			var battery = data[4];
			this.log( 'got battery: ' + battery);
			var characteristic = this.batteryService.getCharacteristic(Characteristic.BatteryLevel);
			characteristic.setValue(battery);
			characteristic = this.batteryService.getCharacteristic(Characteristic.StatusLowBattery);
			characteristic.setValue((battery < 80) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
	}

}


TagAccessory.prototype.requestBattery = function() {
	this.writeCharacteristic.write( new Buffer( [0xF3, 0x16, 0xF3]), true) // writeWithoutResponse
	this.log( 'requested battery');
}


TagAccessory.prototype.identify = function(callback) {
  this.log('identify');
  if (this.peripheral) {
    this.alertCharacteristic.write(new Buffer([0x02]), true);
    setTimeout(function() {
      this.alertCharacteristic.write(new Buffer([0x00]), true);
    }.bind(this), 250);
    callback();
  } else {
    callback(new Error('not connected'));
  }
};

TagAccessory.prototype.onKeyPress = function() {
  var characteristic = this.switchService.getCharacteristic(Characteristic.ProgrammableSwitchEvent);
	if (this.presses <3) {
		this.presses += 1;
	}

	this.log(`got press ${this.presses}`)

  clearTimeout(this.timeout)

  this.timeout = setTimeout(() => {
    characteristic.setValue(this.presses);
		this.log(`sent press ${this.presses}`)
    this.presses = -1
  }, 1000)
};
