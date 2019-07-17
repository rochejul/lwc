/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
import assert from '../../shared/assert';
import { isUndefined, create, ArrayPush } from '../../shared/language';
import { ComponentConstructor, ComponentInterface } from '../component';
import { valueObserved, valueMutated, ReactiveObserver } from '../../libs/mutation-tracker';
import { getComponentVM, VM, runWithBoundaryProtection, VMState } from '../vm';
import { invokeComponentCallback } from '../invoker';
import { startMeasure, endMeasure } from '../performance-timing';

const WireMetaMap: Map<ComponentConstructor, WireHash> = new Map();

/**
 * @wire decorator to wire fields and methods to a wire adapter in
 * LWC Components. This function implements the internals of this
 * decorator.
 */
export default function wire(
    _adapter: WireAdapterConstructor,
    _config?: Record<string, string>
): PropertyDecorator | MethodDecorator {
    if (process.env.NODE_ENV !== 'production') {
        assert.fail('@wire(adapter, config?) may only be used as a decorator.');
    }
    throw new TypeError();
}

export function internalWireFieldDecorator(key: string): PropertyDescriptor {
    return {
        get(this: ComponentInterface): any {
            const vm = getComponentVM(this);
            if (process.env.NODE_ENV !== 'production') {
                assert.isTrue(vm && 'cmpRoot' in vm, `${vm} is not a vm.`);
            }
            valueObserved(this, key);
            return vm.cmpFields[key];
        },
        set(_v: any) {
            /** ignore */
        },
        enumerable: true,
        configurable: true,
    };
}

function storeDef(Ctor: ComponentConstructor, key: string, def: WireDef) {
    const record: Record<string, WireDef> = WireMetaMap.get(Ctor) || create(null);
    record[key] = def;
    WireMetaMap.set(Ctor, record);
}

export function storeWiredMethodMeta(
    Ctor: ComponentConstructor,
    methodName: string,
    adapter: WireAdapterConstructor,
    method: (data: any) => void,
    configCallback: (host: object) => Record<string, any>
) {
    // support for callable adapters
    if ((adapter as any).adapter) {
        adapter = (adapter as any).adapter;
    }
    const def: WireMethodDef = {
        adapter,
        method,
        configCallback,
    };
    storeDef(Ctor, methodName, def);
}

export function storeWiredFieldMeta(
    Ctor: ComponentConstructor,
    fieldName: string,
    adapter: WireAdapterConstructor,
    configCallback: (host: object) => Record<string, any>
) {
    // support for callable adapters
    if ((adapter as any).adapter) {
        adapter = (adapter as any).adapter;
    }
    const def: WireFieldDef = {
        adapter,
        configCallback,
    };
    storeDef(Ctor, fieldName, def);
}

function contextualizer(vm: VM, uid: string, callback: (value: any) => void) {
    const {
        component,
        context: { wiredDisconnecting },
    } = vm;
    // This event is responsible for connecting the host element with another
    // element in the composed path that is providing contextual data. The provider
    // must be listening for a special dom event with the name corresponding to `uid`,
    // which must remain secret, to guarantee that the linkage is only possible via
    // the corresponding wire adapter.
    const internalDomEvent = new CustomEvent(uid, {
        bubbles: true,
        composed: true,
        // avoid leaking the callback function directly to prevent a side channel
        // during the linking phase to the context provider.
        detail(value: any, disconnectCallback: () => void) {
            // adds this callback into the disconnect bucket so it gets disconnected from parent
            // the the element hosting the wire is disconnected
            ArrayPush.call(wiredDisconnecting, disconnectCallback);
            callback(value);
        },
    });
    component.dispatchEvent(internalDomEvent);
}

function createFieldDataCallback(vm: VM) {
    const { component, cmpFields } = vm;
    return (value: any) => {
        // storing the value in the underlying storage
        cmpFields[name] = value;
        valueMutated(component, name);
    };
}

function createMethodDataCallback(vm: VM, method: (data: any) => any) {
    return (value: any) => {
        // dispatching new value into the wired method
        invokeComponentCallback(vm, method, [value]);
    };
}

function createConnector(vm: VM, def: WireDef): WireAdapter {
    const {
        component,
        context: { wiredDisconnecting },
    } = vm;
    let hasPendingConfig: boolean = false;
    const { method, configCallback, adapter } = def;
    const dataCallback = isUndefined(method)
        ? createFieldDataCallback(vm)
        : createMethodDataCallback(vm, method);
    const contextCallback = (uid: string) => {
        const setContext = (value: any) => {
            connector.context(uid, value);
        };
        if (vm.state === VMState.connected) {
            contextualizer(vm, uid, setContext);
        } else {
            // if the ContextLinkEvent is triggered when the wired is not connected, we put it
            // in the queue to call it when the wire adapter is connected since LWC context only
            // work when the host is connected.
            ArrayPush.call(wiredDisconnecting, () => contextualizer(vm, uid, setContext));
        }
    };
    let connector: WireAdapter;
    // creating the reactive observer for reactive params when needed
    const ro = new ReactiveObserver(() => {
        if (hasPendingConfig === false) {
            hasPendingConfig = true;
            // collect new config in the micro-task
            Promise.resolve().then(() => {
                hasPendingConfig = false;
                // resetting current reactive params
                ro.reset();
                // dispatching a new config due to a change in the configuration
                connector.update(configCallback(component));
            });
        }
    });
    runWithBoundaryProtection(
        vm,
        vm,
        () => {
            // pre
            if (process.env.NODE_ENV !== 'production') {
                startMeasure('wire', vm);
            }
        },
        () => {
            // job
            connector = new adapter(dataCallback, contextCallback);
            ro.observe(() => connector.update(configCallback(component)));
        },
        () => {
            // post
            if (process.env.NODE_ENV !== 'production') {
                endMeasure('wire', vm);
            }
        }
    );
    // @ts-ignore the boundary protection executes sync, connector is always defined
    return connector;
}

export function installWireAdapters(vm: VM) {
    const {
        def: { ctor },
    } = vm;
    const meta = WireMetaMap.get(ctor);
    if (isUndefined(meta)) {
        if (process.env.NODE_ENV !== 'production') {
            assert.fail(
                `Internal Error: wire adapters should only be installed in instances with at least one wire declaration.`
            );
        }
    } else {
        const connect = [];
        const disconnect = [];
        for (const name in meta) {
            const def = meta[name];
            const connector = createConnector(vm, def);
            ArrayPush.call(connect, () => connector.connect());
            ArrayPush.call(disconnect, () => connector.disconnect());
        }
        vm.context.wiredConnecting = connect;
        vm.context.wiredDisconnecting = disconnect;
    }
}

export function connectWireAdapters(vm: VM) {
    const {
        context: { wiredConnecting },
    } = vm;
    if (isUndefined(wiredConnecting)) {
        if (process.env.NODE_ENV !== 'production') {
            assert.fail(
                `Internal Error: wire adapters must be installed in instances with at least one wire declaration.`
            );
        }
    }
    for (let i = 0, len = wiredConnecting.length; i < len; i += 1) {
        wiredConnecting[i]();
    }
}

export function disconnectWireAdapters(vm: VM) {
    const {
        context: { wiredDisconnecting },
    } = vm;
    if (isUndefined(wiredDisconnecting)) {
        if (process.env.NODE_ENV !== 'production') {
            assert.fail(
                `Internal Error: wire adapters must be installed in instances with at least one wire declaration.`
            );
        }
    }
    for (let i = 0, len = wiredDisconnecting.length; i < len; i += 1) {
        wiredDisconnecting[i]();
    }
}

type dataCallback = (value: any) => void;
type requestContextCallback = (uid: string) => void;

interface WireAdapter {
    update(config: Record<string, any>);
    context(uid: string, value: any);
    connect();
    disconnect();
}

export interface WireAdapterConstructor {
    new (callback: dataCallback, contextualizer?: requestContextCallback): WireAdapter;
}

// produced by the runtime normalization after processing meta from compiler
export type WireHash = Record<string, WireDef>;

export interface WireDef {
    method?: (data: any) => void;
    adapter: WireAdapterConstructor;
    configCallback: (host: object) => Record<string, any>;
}

export interface WireMethodDef extends WireDef {
    method: (data: any) => void;
}

export interface WireFieldDef extends WireDef {
    method?: undefined;
}
