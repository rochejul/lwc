/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
import assert from '../../shared/assert';
import {
    isUndefined,
    forEach,
    defineProperty,
    getOwnPropertyDescriptor,
    isFunction,
    ArrayPush,
    toString,
    isFalse,
    create,
    StringSplit,
    ArrayShift,
    keys,
    assign,
} from '../../shared/language';
import { ComponentConstructor } from '../component';
import {
    WireAdapterConstructor,
    internalWireFieldDecorator,
    storeWiredMethodMeta,
    storeWiredFieldMeta,
} from './wire';
import { internalTrackDecorator } from './track';
import { createPublicPropertyDescriptor, createPublicAccessorDescriptor } from './api';
import { createObservedFieldPropertyDescriptor } from '../observed-fields';

// data produced by compiler
type WireCompilerMeta = Record<string, WireCompilerDef>;
type TrackCompilerMeta = Record<string, 1>;
type MethodCompilerMeta = string[];
type PropCompilerMeta = Record<string, PropCompilerDef>;
enum PropType {
    Field = 0,
    Set = 1,
    Get = 2,
    GetSet = 3,
}
interface PropCompilerDef {
    config: PropType; // 0 m
    type: string; // TODO: #1301 - make this an enum
}
interface WireCompilerDef {
    method?: number;
    adapter: WireAdapterConstructor;
    // TODO: once the compiler takes care of the configCallback, we can remove params and static here
    // configCallback: (host: object) => Record<string, any>
    params?: Record<string, string>;
    static?: Record<string, any>;
}
interface RegisterDecoratorMeta {
    readonly publicMethods?: MethodCompilerMeta;
    readonly publicProps?: PropCompilerMeta;
    readonly track?: TrackCompilerMeta;
    readonly wire?: WireCompilerMeta;
    readonly fields?: string[];
}

function validateObservedField(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid field ${fieldName} declaration.`);
        }
    }
}

function validateFieldDecoratedWithTrack(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @track ${fieldName} declaration.`);
        }
    }
}

function validateFieldDecoratedWithWire(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @wire(...) ${fieldName} field declaration.`);
        }
    }
}

function validateMethodDecoratedWithWire(Ctor: ComponentConstructor, methodName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, methodName);
        if (
            isUndefined(descriptor) ||
            !isFunction(descriptor.value) ||
            isFalse(descriptor.writable)
        ) {
            assert.fail(`Compiler Error: Invalid @wire(...) ${methodName} method declaration.`);
        }
    }
}

function validateFieldDecoratedWithApi(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @api ${fieldName} field declaration.`);
        }
    }
}

function validateAccessorDecoratedWithApi(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @api get ${fieldName} accessor declaration.`);
        } else if (isFunction(descriptor.set)) {
            assert.isTrue(
                isFunction(descriptor.get),
                `Compiler Error: Missing getter for property ${toString(
                    fieldName
                )} decorated with @api in ${Ctor}. You cannot have a setter without the corresponding getter.`
            );
        } else if (!isFunction(descriptor.get)) {
            assert.fail(`Compiler Error: Missing @api get ${fieldName} accessor declaration.`);
        }
    }
}

function validateMethodDecoratedWithApi(Ctor: ComponentConstructor, methodName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, methodName);
        if (
            isUndefined(descriptor) ||
            !isFunction(descriptor.value) ||
            isFalse(descriptor.writable)
        ) {
            assert.fail(`Compiler Error: Invalid @api ${methodName} method declaration.`);
        }
    }
}

/**
 * INTERNAL: This function can only be invoked by compiled code. The compiler
 * will prevent this function from being imported by user-land code.
 */
export function registerDecorators(
    Ctor: ComponentConstructor,
    meta: RegisterDecoratorMeta
): ComponentConstructor {
    const proto = Ctor.prototype;
    const { publicProps, publicMethods, wire, track, fields } = meta;
    const apiMethods = [];
    const apiFields = [];
    const wiredMethods = [];
    const wiredFields = [];
    if (!isUndefined(publicProps)) {
        for (const fieldName in publicProps) {
            const propConfig = publicProps[fieldName];
            let descriptor: PropertyDescriptor | undefined;
            if (propConfig.config > 0) {
                // accessor declaration
                if (process.env.NODE_ENV !== 'production') {
                    validateAccessorDecoratedWithApi(Ctor, fieldName);
                }
                descriptor = getOwnPropertyDescriptor(proto, fieldName);
                descriptor = createPublicAccessorDescriptor(
                    fieldName,
                    descriptor as PropertyDescriptor
                );
            } else {
                // field declaration
                if (process.env.NODE_ENV !== 'production') {
                    validateFieldDecoratedWithApi(Ctor, fieldName);
                }
                descriptor = createPublicPropertyDescriptor(fieldName);
            }
            ArrayPush.call(apiFields, fieldName);
            defineProperty(proto, fieldName, descriptor);
        }
    }
    if (!isUndefined(publicMethods)) {
        forEach.call(publicMethods, methodName => {
            if (process.env.NODE_ENV !== 'production') {
                validateMethodDecoratedWithApi(Ctor, methodName);
            }
            ArrayPush.call(apiMethods, methodName);
        });
    }
    if (!isUndefined(wire)) {
        for (const fieldOrMethodName in wire) {
            const { adapter, method } = wire[fieldOrMethodName];
            // TODO: configCallback should come from compiler directly
            const { static: staticParams, params: dynamicParams } = wire[fieldOrMethodName];
            const configCallback = buildConfigExtractor(staticParams, dynamicParams);
            if (method === 1) {
                if (process.env.NODE_ENV !== 'production') {
                    validateMethodDecoratedWithWire(Ctor, fieldOrMethodName);
                }
                ArrayPush.call(wiredMethods, fieldOrMethodName);
                storeWiredMethodMeta(
                    Ctor,
                    fieldOrMethodName,
                    adapter,
                    proto[fieldOrMethodName] as (data: any) => void,
                    configCallback
                );
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    validateFieldDecoratedWithWire(Ctor, fieldOrMethodName);
                }
                storeWiredFieldMeta(Ctor, fieldOrMethodName, adapter, configCallback);
                ArrayPush.call(wiredFields, fieldOrMethodName);
                defineProperty(
                    proto,
                    fieldOrMethodName,
                    internalWireFieldDecorator(fieldOrMethodName)
                );
            }
        }
    }
    if (!isUndefined(track)) {
        for (const fieldName in track) {
            if (process.env.NODE_ENV !== 'production') {
                validateFieldDecoratedWithTrack(Ctor, fieldName);
            }
            defineProperty(proto, fieldName, internalTrackDecorator(fieldName));
        }
    }
    if (!isUndefined(fields)) {
        for (const fieldName in fields) {
            if (process.env.NODE_ENV !== 'production') {
                validateObservedField(Ctor, fieldName);
            }
            defineProperty(proto, fieldName, createObservedFieldPropertyDescriptor(fieldName));
        }
    }
    setDecoratorsMeta(Ctor, {
        apiMethods,
        apiFields,
        wiredMethods,
        wiredFields,
    });
    return Ctor;
}

const signedDecoratorToMetaMap: Map<ComponentConstructor, DecoratorMeta> = new Map();

interface DecoratorMeta {
    readonly apiMethods: string[];
    readonly apiFields: string[];
    readonly wiredMethods: string[];
    readonly wiredFields: string[];
}

function setDecoratorsMeta(Ctor: ComponentConstructor, meta: DecoratorMeta) {
    signedDecoratorToMetaMap.set(Ctor, meta);
}

const defaultMeta: DecoratorMeta = {
    apiMethods: [],
    apiFields: [],
    wiredMethods: [],
    wiredFields: [],
};

export function getDecoratorsMeta(Ctor: ComponentConstructor): DecoratorMeta {
    const meta = signedDecoratorToMetaMap.get(Ctor);
    return isUndefined(meta) ? defaultMeta : meta;
}

// TODO: this should eventually be done by the compiler directly
// a reactive parameter represents a dot-notation member property expression
interface ReactiveParameter {
    reference: string; // the complete parameter (aka original foo.bar.baz)
    head: string; // head of the parameter
    tail: string[]; // remaining tail of the parameter
}

const refCache: Record<string, ReactiveParameter> = create(null);

// TODO: this should eventually be done by the compiler directly
function buildReactiveParameter(reference: string): ReactiveParameter {
    let rp: ReactiveParameter | undefined = refCache[reference];
    if (rp === undefined) {
        // @ts-ignore some funky definition for reference.split('.')
        const segments = StringSplit.call(reference, '.');
        rp = {
            reference,
            head: ArrayShift.call(segments),
            tail: segments,
        };
        // caching
        refCache[reference] = rp;
    }
    return rp;
}

// TODO: this should eventually be done by the compiler directly
function buildReactiveParamsConfig(
    wireDefParams: Record<string, string>
): Record<string, ReactiveParameter> {
    const record = create(null);
    forEach.call(keys(wireDefParams), key => {
        record[key] = buildReactiveParameter(wireDefParams[key]);
    });
    return record;
}

// TODO: this should eventually be done by the compiler directly
function getReactiveParameterValue(host: object, reactiveParameter: ReactiveParameter): any {
    const { tail, head } = reactiveParameter;
    let value = host[head];
    for (let i = 0, len = tail.length; i < len; i++) {
        if (value != null) {
            // null or undefined should produce undefined
            return undefined;
        }
        const segment = tail[i];
        value = value[segment];
    }
    return value;
}

// TODO: this should eventually be done by the compiler directly
function computeReactiveParams(obj: object, paramsConfig): Record<string, any> {
    const value = create(null);
    forEach.call(keys(paramsConfig), (key: string) => {
        const config = paramsConfig[key];
        value[key] = getReactiveParameterValue(obj, config);
    });
    return value;
}

// TODO: this should eventually be done by the compiler directly
function buildConfigExtractor(
    cfgStatic: Record<string, any> | undefined,
    cfgDynamic: Record<string, string> | undefined
): (host: object) => Record<string, any> {
    const paramsConfig = isUndefined(cfgDynamic)
        ? create(null)
        : buildReactiveParamsConfig(cfgDynamic);
    return (host: object): Record<PropertyKey, any> => {
        const reactiveParams = computeReactiveParams(host, paramsConfig);
        return assign({}, cfgStatic, reactiveParams);
    };
}
