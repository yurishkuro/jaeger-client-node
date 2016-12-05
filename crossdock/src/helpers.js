// @flow
// Copyright (c) 2016 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import * as constants from './constants.js';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import DefaultContext from '../../src/default_context';
import opentracing from 'opentracing';
import request from 'request';
import RSVP from 'rsvp';
import Span from '../../src/span.js';
import SpanContext from '../../src/span_context.js';
import Tracer from '../../src/tracer.js';
import TChannel from 'tchannel/channel';
import TChannelThrift from 'tchannel/as/thrift';
import TChannelBridge from '../../src/tchannel_bridge';
import Utils from '../../src/util.js';

export default class Helpers {
    _tracer: Tracer;
    _bridge: TChannelBridge;
    _tracedChannel: any;

    constructor(tracer: Tracer) {
        this._tracer = tracer;

        var channel = TChannel().makeSubChannel({
            serviceName: 'node',
            peers: [Utils.myIp() + ':8082']
        });

        let crossdockSpec = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'jaeger-idl', 'thrift', 'crossdock', 'tracetest.thrift'), 'utf8');
        let thriftChannel = TChannelThrift({
            channel: channel,
            source: crossdockSpec
        });

        let bridge = new TChannelBridge(this._tracer);
        this._tracedChannel= bridge.tracedChannel(thriftChannel);
    }

    handleRequest(isStartRequest: boolean, traceRequest: any, serverSpan: Span): void {
        if (isStartRequest) {
            serverSpan.setBaggageItem(constants.BAGGAGE_KEY, traceRequest.baggage);
            if (traceRequest.sampled) {
                serverSpan.setTag(opentracing.Tags.SAMPLING_PRIORITY, 1);
            }
        }

        // do async call to prepareResponse
        return this.prepareResponse(traceRequest.serverRole, traceRequest.downstream, serverSpan);
    }

    prepareResponse(serverRole: string, downstream: Downstream, serverSpan: Span): any {
        return new RSVP.Promise((resolve, reject) => {
            let observedSpan = this.observeSpan(serverSpan);
            let response: TraceResponse = {
                span: observedSpan,
                notImplementedError: ''
            };
            Helpers.log(serverRole, 'observed span', Helpers.json2str(observedSpan));

            if (downstream) {
                this.callDownstream(serverRole, downstream, serverSpan).then((downstreamResponse) => {
                    response.downstream = downstreamResponse;
                    Helpers.log(serverRole, 'returning response', Helpers.json2str(response));
                    resolve(response);
                });
            } else {
                Helpers.log(serverRole, 'returning response', Helpers.json2str(response));
                resolve(response);
            }

        });
    }

    callDownstream(serverRole: string, downstream: Downstream, serverSpan: Span): any {
        Helpers.log(serverRole, 'calling downstream', Helpers.json2str(downstream));
        let transport = downstream.transport;
        if (transport === constants.TRANSPORT_HTTP) {
            return this.callDownstreamHTTP(downstream, serverSpan);
        } else if (transport === constants.TRANSPORT_TCHANNEL) {
            return this.callDownstreamTChannel(downstream, serverSpan);
        } else if (transport == constants.TRANSPORT_DUMMY) {
            return new RSVP.Promise((resolve, reject) => {
                resolve({ 'notImplementedError': 'Dummy has not been implemented' });
            });
        } else {
            return new RSVP.Promise((resolve, reject) => {
                resolve({ 'notImplementedError': `Unrecognized transport received: ${transport}` })
            });
        }
    }

    callDownstreamHTTP(downstream: Downstream, serverSpan: Span): any {
        return new RSVP.Promise((resolve, reject) => {

            let port = parseInt(downstream.port);
            let downstreamUrl = `http://${downstream.host}:${port}/join_trace`;

            let clientSpan = this._tracer.startSpan('client-span', { childOf: serverSpan.context() });
            let headers = { 'Content-Type': 'application/json' };
            this._tracer.inject(clientSpan.context(), opentracing.FORMAT_HTTP_HEADERS, headers);

            request.post({
                'url': downstreamUrl,
                'forever': true,
                'headers': headers,
                'body': JSON.stringify({
                    'serverRole': downstream.serverRole,
                    'downstream': downstream.downstream
                })
            }, (err, response) => {
                if (err) {
                    Helpers.log('error in downstream call:', err);
                    clientSpan.finish();
                    reject(err);
                    return;
                }

                clientSpan.finish();
                let downstreamResponse = JSON.parse(response.body);
                resolve(downstreamResponse);
            });
        });
    }

    callDownstreamTChannel(downstream: Downstream, serverSpan: Span): any {
        return new RSVP.Promise((resolve, reject) => {
            let port = parseInt(downstream.port);
            let downstreamUrl = `http://${downstream.host}:${port}/join_trace`;

            let context = new DefaultContext();
            context.setSpan(serverSpan);
            let request = this._tracedChannel.request({
                timeout: 5000,
                context: context,
                headers: {
                    cn: 'tcollector-requestor'
                },
                trace: true,
                serviceName: 'node',
                retryFlags: {never: true}
            });
            let joinTraceRequest: JoinTraceRequest = {
                'serverRole': downstream.serverRole,
            };

            if (downstream.downstream) {
                joinTraceRequest.downstream = downstream.downstream;
            }

            request.send(
                'TracedService::joinTrace',
                null,
                { request: joinTraceRequest },
                (err, response) => {
                    if (err) {
                        Helpers.log('tchannel err', err);
                        return;
                    }
                    resolve(response.body);
            });
        });
    }

    observeSpan(span: Span): ObservedSpan {
        let observed: ObservedSpan = {
            traceId: 'no span found',
            sampled: false,
            baggage: 'no span found'
        };
 
        if (span) {
            observed = {
                traceId: span.context().traceIdStr || '',
                sampled: span.context().isSampled(),
                baggage: span.getBaggageItem(constants.BAGGAGE_KEY)
            };
        }
        return observed;
    }

    static log(...args: any[]): void {
        // $FlowIgnore - stop complaining about property `env` not found
        if (process.env.NODE_ENV !== 'test') {
            console.log.apply(null, args);
        }
    }

    static json2str(json: any): string {
        return JSON.stringify(json);
    }
}
