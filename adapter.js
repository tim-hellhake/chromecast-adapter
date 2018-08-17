"use strict";

const { Client, Application, MediaController, DefaultMediaReceiver } = require("castv2-client");
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

class ReadonlyProperty extends Property {
    constructor(device, name, description, value) {
        description.writable = false;
        super(device, name, description, value);
    }

    setValue(value) {
        return Promise.reject("Read only property");
    }
}

class Chromecast extends Device {
    constructor(adapter, host) {
        super(adapter, host.fullname);
        this.client = new Client();
        this.address = host.addresses[0];
        this.setName(host.txt.fn);
        this.description = host.txt.md;
        this["@type"] = [ "OnOffSwitch" ];

        this.properties.set('volume', new ChromecastProperty(this, 'volume', {
            label: 'Volume',
            type: 'number',
            unit: 'percent',
            "@type": 'LevelProperty'
        }, 100));

        this.properties.set('on', new ChromecastProperty(this, 'on', {
            label: 'On/Off',
            type: "boolean",
            "@type": "OnOffProperty"
        }, false));

        this.properties.set('playing', new ChromecastProperty(this, 'playing', {
            label: 'Play/Pause',
            type: 'boolean',
            "@type": "BooleanProperty"
        }, false));

        this.properties.set('muted', new ChromecastProperty(this, 'muted', {
            label: 'Muted',
            type: 'boolean',
            "@type": "BooleanProperty"
        }, false));

        this.properties.set('app', new ReadonlyProperty(this, 'app', {
            label: 'App',
            type: 'string'
        }, ''));

        //TODO readonly props for title, artist etc.?

        this.ready = this.connect().then(() => this.adapter.handleDeviceAdded(this));
    }

    async connect(initial = true) {
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
            if(!initial) {
                this.adapter.removeThing(this);
            }
            throw e;
        }

        this.client.on('close', async () => {
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
                this.adapter.removeThing(this);
                throw e;
            }
        });

        this.client.on('error', (e) => {
            console.warn("Re-creating client after", e);
            this.client.close();
            this.client = new Client();
            this.connect(false);
        });

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
        if(sessions.length) {
            this.updateProp('app', sessions[0].displayName);
            if(!sessions[0].isIdleScreen) {
                this.currentApplication = sessions[0].appId;
                this.updateProp('on', true);
                this.joinMediaSession(sessions[0]);
            }
        }

        this.client.on('status', (status) => {
            if(!status.applications && this.currentApplication) {
                this.updateProp('on', false);
                this.updateProp('app', '');
                this.currentApplication = undefined;
                this.media = undefined;
            }
            else if(status.applications && status.applications[0].appId != this.currentApplication && !status.applications[0].isIdleScreen) {
                this.updateProp('on', true);
                this.updateProp('app', status.applications[0].displayName);
                this.currentApplication = status.applications[0].appId;
                this.joinMediaSession(status.applications[0]);
            }
            else if(status.applications && status.applications.length) {
                this.updateProp('app', status.applications[0].displayName);
                if(status.applications[0].transportId && !this.media) {
                    this.joinMediaSession(status.applications[0]);
                }
            }
            this.updateProp('volume', status.volume.level * 100);
            this.updateProp('muted', status.volume.muted);
            this.volumeStep = status.volume.stepInterval;
        });
    }

    updatePlaying(playerState) {
        this.updateProp('playing', playerState === 'PLAYING' || playerState === 'BUFFERING');
    }

    joinMediaSession(session) {
        const FakeApp = class extends DefaultMediaReceiver {}
        FakeApp.APP_ID = session.appId;
        if(!session.transportId) {
            return;
        }
        this.client.join(session, FakeApp, (e, r) => {
            if(e) {
                console.error(e);
            }
            else {
                this.media = r;
                this.media.on('status', (status) => {
                    // Shape: https://developers.google.com/cast/docs/reference/messages#MediaStatusMess
                    this.updatePlaying(status.playerState);
                });
                this.media.on('close', () => {
                    this.updateProp('playing', false);
                    this.media = undefined;
                    this.transportId = undefined;
                });
                this.media.getStatus((e, r) => {
                    if(e) {
                        console.error(e);
                    }
                    else if(r) {
                        this.updatePlaying(r.playerState);
                    }
                    else {
                        this.updatePlaying(false);
                    }
                });
            }
        });
    }

    updateProp(propertyName, value) {
        const property = this.findProperty(propertyName);
        if(property.value !== value) {
            property.setCachedValue(value);
            super.notifyPropertyChanged(property);
        }
    }

    setVolume(value, what = 'level') {
        return new Promise((resolve, reject) => {
            this.client.setVolume({
                [what]: value
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

    async launch(appId = DefaultMediaReceiver.APP_ID) {
        const availability = await new Promise((resolve, reject) => {
            this.client.getAppAvailability(appId, (e, r) => {
                if(e) {
                    reject(e);
                }
                else {
                    resolve(r);
                }
            });
        });
        if(availability[appId]) {
            let TempApp = class extends Application {};
            TempApp.APP_ID = appId;
            if(appId = DefaultMediaReceiver) {
                TempApp = DefaultMediaReceiver;
            }
            return new Promise((resolve, reject) => {
                this.client.launch(TempApp, (e, r) => {
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
            case 'muted':
                await this.setVolume(property.value, property.name);
            break;
            case 'on':
                // Sadly we can't use the chromecast CRC commands - these are only available to Google.
                if(!property.value) {
                    await this.stop();
                }
                else {
                    await this.launch();
                }
            break;
            case 'playing':
                if(this.media) {
                    await new Promise((resolve, reject) => {
                        this.media[property.value ? 'play' : 'pause']((e, r) => {
                            if(e) {
                                reject(e);
                            }
                            else {
                                resolve(r);
                            }
                        });
                    });
                }
                else {
                    property.setCachedValue(!property.value);
                    throw "Can't change playing when nothing is playing";
                }
            break;
        }
        super.notifyPropertyChanged(property);
    }
}

class ChromecastAdapter extends Adapter {
    constructor(addonManager, packageName) {
        super(addonManager, 'ChromecastAdapter', packageName);
        addonManager.addAdapter(this);

        this.browser = mdns.Browser(mdns.tcp('googlecast'));

        this.startPairing(60);
    }

    addDevice(device) {
        if(device.fullname in this.devices) {
            console.warn('Device: ' + device.fullname + ' already exists.');
            return;
        }
        const dev = new Chromecast(this, device);
        return dev.ready;
    }

    startPairing(timeoutSeconds) {
        if(!this.timeout) {
            this.browser.on('serviceUp', (service) => {
                this.addDevice(service);
            });
            this.browser.start();
            this.timeout = setTimeout(() => this.cancelPairing(), timeoutSeconds * 1000);
        }
    }

    cancelPairing() {
        if(this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        this.browser.stop();
    }
}

module.exports = (addonManager, manifest) => {
    const adapter = new ChromecastAdapter(addonManager, manifest.name);
};
