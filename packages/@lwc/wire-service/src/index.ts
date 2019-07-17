/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

/**
 * Registers a wire adapter factory for Lightning Platform.
 * @deprecated
 */
export function register(
    adapterId: any,
    adapterEventTargetCallback: (eventTarget: WireEventTarget) => void
) {
    if (!adapterId) {
        new TypeError('adapter id must be truthy');
    }
    if (typeof adapterEventTargetCallback !== 'function') {
        new TypeError('adapter factory must be a callable');
    }
    if ('adapter' in adapterId) {
        new TypeError('adapter id is already associated to an adapter factory');
    }
    adapterId.adapter = class extends WireAdapter {
        constructor(dataCallback: dataCallback, requestContextCallback?: requestContextCallback) {
            super(dataCallback, requestContextCallback);
            adapterEventTargetCallback(this.eventTarget);
        }
    };
}

import { LinkContextEvent } from './link-context-event';
import { ValueChangedEvent } from './value-changed-event';

const { forEach, push: ArrayPush, splice: ArraySplice, indexOf: ArrayIndexOf } = Array.prototype;
const { create } = Object;

// wire event target life cycle connectedCallback hook event type
const CONNECT = 'connect';
// wire event target life cycle disconnectedCallback hook event type
const DISCONNECT = 'disconnect';
// wire event target life cycle config changed hook event type
const CONFIG = 'config';

type NoArgumentListener = () => void;
interface ConfigListenerArgument {
    [key: string]: any;
}
type ConfigListener = (config: ConfigListenerArgument) => void;

type WireEventTargetListener = NoArgumentListener | ConfigListener;

export interface WireEventTarget {
    addEventListener: (type: string, listener: WireEventTargetListener) => void;
    removeEventListener: (type: string, listener: WireEventTargetListener) => void;
    dispatchEvent: (evt: ValueChangedEvent | LinkContextEvent) => boolean;
}

function removeListener(listeners: WireEventTargetListener[], toRemove: WireEventTargetListener) {
    const idx = ArrayIndexOf.call(listeners, toRemove);
    if (idx > -1) {
        ArraySplice.call(listeners, idx, 1);
    }
}

type dataCallback = (value: any) => void;
type requestContextCallback = (uid: string) => void;
export interface WireAdapterConstructor {
    new (callback: dataCallback, contextualizer?: requestContextCallback): WireAdapter;
}

export class WireAdapter {
    private callback: dataCallback;
    private contextualizer: requestContextCallback | undefined;

    private connecting: NoArgumentListener[] = [];
    private disconnecting: NoArgumentListener[] = [];
    private configuring: ConfigListener[] = [];
    private contexting: Record<string, ConfigListener[]> = create(null);

    constructor(callback: dataCallback, contextualizer?: requestContextCallback) {
        this.callback = callback;
        this.contextualizer = contextualizer;
        this.eventTarget = {
            addEventListener: (type: string, listener: WireEventTargetListener): void => {
                switch (type) {
                    case CONNECT: {
                        this.connecting.push(listener as NoArgumentListener);
                        break;
                    }
                    case DISCONNECT: {
                        this.disconnecting.push(listener as NoArgumentListener);
                        break;
                    }
                    case CONFIG: {
                        this.configuring.push(listener as ConfigListener);
                        break;
                    }
                    default:
                        throw new Error(`Invalid event type ${type}.`);
                }
            },
            removeEventListener: (type: string, listener: WireEventTargetListener): void => {
                switch (type) {
                    case CONNECT: {
                        removeListener(this.connecting, listener);
                        break;
                    }
                    case DISCONNECT: {
                        removeListener(this.disconnecting, listener);
                        break;
                    }
                    case CONFIG: {
                        removeListener(this.configuring, listener);
                        break;
                    }
                    default:
                        throw new Error(`Invalid event type ${type}.`);
                }
            },
            dispatchEvent: (evt: ValueChangedEvent | LinkContextEvent): boolean => {
                if (evt instanceof ValueChangedEvent) {
                    const value = evt.value;
                    this.callback(value);
                } else if (evt instanceof LinkContextEvent) {
                    // This event is responsible for connecting the adapter with another
                    // provider that is providing contextual data per uid.
                    if (this.contextualizer !== undefined) {
                        const { uid, callback } = evt;
                        if (this.contexting[uid] !== undefined) {
                            ArrayPush.call(this.contexting, callback);
                        } else {
                            this.contexting[uid] = [callback];
                        }
                        // call the contextualizer to ask for a particular context uid
                        this.contextualizer.call(undefined, uid);
                    }
                } else {
                    throw new Error(`Invalid event type ${(evt as any).type}.`);
                }
                return false; // canceling signal since we don't want this to propagate
            },
        };
    }

    protected eventTarget: WireEventTarget;

    update(config: Record<string, any>) {
        forEach.call(this.configuring, listener => {
            listener.call(undefined, config);
        });
    }

    context(uid: string, value: any) {
        const listeners = this.contexting[uid];
        if (listeners !== undefined) {
            forEach.call(listeners, listener => {
                listener.call(undefined, value);
            });
        }
    }

    connect() {
        forEach.call(this.connecting, listener => listener.call(undefined));
    }

    disconnect() {
        forEach.call(this.disconnecting, listener => listener.call(undefined));
    }
}

// re-exporting event constructors
export { LinkContextEvent, ValueChangedEvent };
