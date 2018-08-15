"use strict";

const { Client, Application } = require("castv2-client");
const mdns = require("dnssd");

let Adapter, Device, Property, Event;
try {
    Adapter = require('../adapter');
    Device = require('../device');
    Property = require('../property');
    Event = require('../event');
}
catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
        throw e;
    }

    const gwa = require('gateway-addon');
    Adapter = gwa.Adapter;
    Device = gwa.Device;
    Property = gwa.Property;
    Event = gwa.Event;
}

class ChromecastProperty extends Property {
    constructor(device, name, description, value) {
        super(device, name, description);
        this.setCachedValue(value);
    }

    async setValue(value) {
        if(value !== this.value) {
            this.setCachedValue(value);
            await this.device.notifyPropertyChanged(this);
        }
        return this.value;
    }
}

class Chromecast extends Device {
    constructor(adapter, host) {
        super(adapter, host.fullname);
        this.client = new Client();
        this.address = host.addresses[0];
        this.setName(host.txt.fn);
        this.description = host.txt.md;
        //this["@type"] = [ "MediaPlayer" ];

        this.properties.set('volume', new ChromecastProperty(this, 'volume', {
            label: 'Volume',
            type: 'number',
            unit: 'percent',
            "@type": 'LevelProperty'
        }, 100));

        this.addAction('stop', {
            label: 'Stop',
            description: 'Stop currently casted application'
        });

        this.addEvent('launch', {
            type: "string",
            name: 'appID'
        });
        this.addEvent('stop', {
            type: "string",
            name: 'appID'
        });

        this.ready = this.connect();
    }

    async connect() {
        try {
            await new Promise((resolve, reject) => {
                this.client.connect(this.address, () => {
                    resolve();
                    this.client.removeListener('error', reject);
                });
                this.client.once('error', reject);
            });
        }
        catch(e) {
            this.client.close();
            throw e;
        }

        const vol = await new Promise((resolve, reject) => this.client.getVolume((e, r) => {
            if(e) {
                reject(e);
            }
            else {
                resolve(r);
            }
        }));
        this.volumeStep = vol.stepInterval;
        this.updateProp('volume', vol.level * 100);

        const sessions = await this.getSessions();
        if(sessions.length && !sessions[0].isIdleScreen) {
            this.currentApplication = sessions[0].appId;
        }

        this.client.on('status', (status) => {
            if(!status.applications && this.currentApplication) {
                this.eventNotify(new Event(this, 'stop', this.currentApplication));
                this.currentApplication = undefined;
            }
            else if(status.applications && status.applications[0].appId != this.currentApplication && !status.applications[0].isIdleScreen) {
                this.eventNotify(new Event(this, 'launch', status.applications[0].appId));
                this.currentApplication = status.applications[0].appId;
            }
            this.updateProp('volume', status.volume.level * 100);
            this.volumeStep = status.volume.stepInterval;
        });

        this.adapter.handleDeviceAdded(this);
    }

    updateProp(propertyName, value) {
        const property = this.findProperty(propertyName);
        property.setCachedValue(value);
        super.notifyPropertyChanged(property);
    }

    setVolume(value) {
        return new Promise((resolve, reject) => {
            this.client.setVolume({
                controlType: 'attenuation', //TODO does this have to match what we get?
                level: value,
                muted: value <= 0,
                stepInterval: this.volumeStep
            }, (e, r) => {
                if(e) {
                    reject(e);
                }
                else {
                    resolve(r);
                }
            });
        });
    }

    getSessions() {
        return new Promise((resolve) => {
            this.client.getSessions((e, r) => {
                if(e) {
                    reject(e);
                }
                else {
                    resolve(r)
                }
            });
        });
    }

    async stop() {
        const sessions = await this.getSessions();
        if(sessions && sessions.length && !sessions[0].isIdleScreen)
        {
            console.log(sessions);
            const app = await new Promise((resolve, reject) => {
                this.client.join(sessions[0], Application, (e, r) => {
                    if(e) {
                        reject(e);
                    }
                    else {
                        resolve(r);
                    }
                });
            });
            return new Promise((resolve, reject) => {
                this.client.stop(app, (e, r) => {
                    if(e) {
                        reject(e);
                    }
                    else {
                        resolve(r);
                    }
                });
            });
        }
    }

    async notifyPropertyChanged(property) {
        switch(property.name) {
            case 'volume':
                await this.setVolume(property.value / 100);
            break;
        }
        super.notifyPropertyChanged(property);
    }

    async performAction(action) {
        switch(action.name) {
            case "stop":
                action.start();
                await this.stop();
                action.finish();
            break;
        }
    }
}

class ChromecastAdapter extends Adapter {
    constructor(addonManager, packageName, config) {
        super(addonManager, 'ChromecastAdapter', packageName);
        addonManager.addAdapter(this);

        this.browser = mdns.Browser(mdns.tcp('googlecast'));

        this.startPairing(60);
    }

    addDevice(device) {
        const dev = new Chromecast(this, device);
        return dev.ready;
    }

    startPairing(timeoutSeconds) {
        this.browser.on('serviceUp', (service) => {
            this.addDevice(service);
        });
        this.browser.start();
        setTimeout(() => this.cancelPairing(), timeoutSeconds * 1000);
    }

    cancelPairing() {
        this.browser.stop();
    }
}

module.exports = (addonManager, manifest) => {
    const adapter = new ChromecastAdapter(addonManager, manifest.name, manifest.moziot.config)
};
