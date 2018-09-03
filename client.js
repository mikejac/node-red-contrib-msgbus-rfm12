/**
 * Copyright 2018 Michael Jacobsen.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict"

    const async      = require("async")
    const SerialPort = require("serialport")
    const Readline   = require("@serialport/parser-readline")

	/******************************************************************************************************************
	 * 
	 *
	 */
    function RFM12MsgBusClientNode(config) {
        RED.nodes.createNode(this, config)

        this.serialport     = config.serialport
        this.serialbaud     = parseInt(config.serialbaud)
        this.connected      = false
        this.connecting     = false
        this.closing        = false
        this.users          = {}
        this.subscriptions  = {}
        this.debugs         = {}
        this.ctrlstatus     = {}
        this.devicestatus   = {}
        this.port           = null
        this.wdt            = 65;
        this.wdtStatus      = -1;
        this.timerHandle    = null;

        var node = this

        /******************************************************************************************************************
         * functions
         *
         */
        this.disableTimer = function() {
            if (node.timerHandle) {    
                clearTimeout(node.timerHandle);
                node.timerHandle = null;    
            }
        }
          
        this.enableTimer = function() {
            if (node.timerHandle) {
                RED.log.debug("RFM12MsgBusClientNode(enableTimer): clear timer");
                clearTimeout(node.timerHandle);
                node.timerHandle = null;
            }

            if (node.wdt > 0) {
                RED.log.debug("RFM12MsgBusClientNode(enableTimer): node.wdt > 0");
                node.timerHandle = setTimeout(node.timerProc.bind(this), node.wdt * 1000);
            } else {
                RED.log.debug("RFM12MsgBusClientNode(enableTimer): node.wdt <= 0");
            }
        }
          
        this.resetTimer = function() {
            if (node.wdt <= 0) {
                return;
            }

            node.enableTimer();
            RED.log.debug("RFM12MsgBusClientNode(resetTimer): node.wdtStatus = " + node.wdtStatus)

            if (node.wdtStatus != 1) {
                node.wdtStatus = 1
            }
        }

        this.timerProc = function() {
            RED.log.debug("RFM12MsgBusClientNode(timerproc): run; wdt = " + node.wdt);

            if (node.wdtStatus != 0) {
                node.wdtStatus = 0
    
                RED.log.debug("RFM12MsgBusClientNode(timerproc): timeout");

                var msg = {
                    topic:   "status",
                    payload: "timeout"
                }

                callStatusHandlers(node, msg)
            }
        }

        /******************************************************************************************************************
         * define functions called by nodes
         *
         */
        this.register = function(rfm12Node){
            RED.log.debug("RFM12MsgBusClientNode::register()")
            node.users[rfm12Node.id] = rfm12Node

            if (Object.keys(node.users).length === 1) {
                node.connect()
            }
        }

        this.deregister = function(rfm12Node, done){
            RED.log.debug("RFM12MsgBusClientNode::deregister()")
            delete node.users[rfm12Node.id];

            if (node.closing) {
                RED.log.debug("RFM12MsgBusClientNode::deregister(): done; node.closing")
                return done()
            }

            if (Object.keys(node.users).length === 0) {
                RED.log.debug("RFM12MsgBusClientNode::deregister(): done; no more clients")
                return done()
            }

            RED.log.debug("RFM12MsgBusClientNode::deregister(): done")
            done()
        }

        this.connect = function () {
            RED.log.debug("RFM12MsgBusClientNode::connect()")

            if (!node.connected && !node.connecting) {
                node.connecting = true

                node.port = new SerialPort(node.serialport, 
                                            {
                                                baudRate: node.serialbaud,
                                                dataBits: 8,
                                                stopBits: 1
                                            })

                node.parser = node.port.pipe(new Readline({ delimiter: '\n' }));

                // error handler
                node.port.on('error', function(err) {
                    node.error(err.message)
                })

                // port open handler
                node.port.on('open', function() {
                    RED.log.debug("RFM12MsgBusClientNode(): on open");

                    node.connected  = true
                    node.connecting = false

                    node.log(RED._("rfm12.state.connected", {serialport:node.serialport + ":" + node.serialbaud}))

                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill: "green",shape: "dot",text: "node-red:common.status.connected"})

                            if (typeof node.users[id].connected === 'function') {
                                node.users[id].connected()      // inform user-node
                            }
                        }
                    }

                    node.enableTimer()
                })

                // disconnect handler
                node.port.on('disconnect', function() { 
                    RED.log.debug("RFM12MsgBusClientNode::disconnect()")

                    if (node.connected) {
                        node.connected = false
                        node.log(RED._("rfm12.state.disconnected", {serialport:node.serialport + ":" + node.serialbaud}))

                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"red", shape:"ring", text:"node-red:common.status.disconnected"})

                                if (typeof node.users[id].disconnected === 'function') {
                                    node.users[id].disconnected()      // inform user-node
                                }
                            }
                        }
                    } else if (node.connecting) {
                        node.log(RED._("rfm12.state.connect-failed", {serialport:node.serialport + ":" + node.serialbaud}))
                    }
                })

                // incoming data handler
                node.parser.on('data', function (data) {
                    RED.log.debug("RFM12MsgBusClientNode(data): data = '" + data + "'")

                    if(data[0] == '%') {                    // alive
                        RED.log.debug("RFM12MsgBusClientNode(data): controller alive")
                        node.resetTimer()
                    } else if(data[0] == '!') {             // incoming data from a node
                        var posType    = 1
                        var posNode    = data.indexOf(':', posType) + 1
                        var posDataId  = data.indexOf(':', posNode) + 1
                        var posService = data.indexOf(':', posDataId) + 1
                        var posValue   = data.indexOf(':', posService) + 1

                        var typeB    = data.slice(posType, posNode - 1)
                        var nodeB    = data.slice(posNode, posDataId - 1)
                        var dataIdB  = data.slice(posDataId, posService - 1)
                        var serviceB = data.slice(posService, posValue - 1)
                        var valueB   = data.slice(posValue)

                        RED.log.debug("RFM12MsgBusClientNode(data): value typeB    = '" + typeB + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value nodeB    = '" + nodeB + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value dataIdB  = '" + dataIdB + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value serviceB = '" + serviceB + "'")

                        var typeS    = typeB.toString('ascii')
                        var nodeN    = parseInt(nodeB)
                        var dataIdN  = parseInt(dataIdB)
                        var serviceS = serviceB.toString('ascii')
                        var valueN   = parseInt(valueB)

                        RED.log.debug("RFM12MsgBusClientNode(data): value typeS    = '" + typeS + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value nodeN    = '" + nodeN + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value dataIdN  = '" + dataIdN + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value serviceS = '" + serviceS + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): value valueN   = '" + valueN + "'")

                        var msg = {}
                        msg.node    = nodeN
                        msg.service = serviceS
                        msg.type    = typeS
                        msg.dataId  = dataIdN
                        msg.topic   = typeS
                        msg.payload = valueN

                        for (var s in node.subscriptions) {
                            if (node.subscriptions.hasOwnProperty(s)) {
                                if (node.subscriptions[s].hasOwnProperty('0')) {
                                    var n = node.subscriptions[s][0]

                                    if (nodeN == n.node && dataIdN == n.dataId && serviceS == n.service && typeS == n.type) {
                                        n.handler(msg)
                                    }
                                }
                            }
                        }
                    } else if(data[0] == '#') {         // debug message from controller
                        var s1 = data.slice(data.indexOf(':') + 1)
                        var s2 = s1.toString('ascii').trim()

                        RED.log.debug("RFM12MsgBusClientNode(data): debug = '" + s2 + "'")

                        var msg     = {}
                        msg.topic   = "debug"
                        msg.payload = s2

                        for (var s in node.debugs) {
                            if (node.debugs.hasOwnProperty(s)) {
                                if (node.debugs[s].hasOwnProperty('0')) {
                                    var n = node.debugs[s][0]

                                    n.handler(msg)
                                }
                            }
                        }
                    } else if(data[0] == '$') {         // reply
                        var s1 = data.toString('ascii').trim()

                        RED.log.debug("RFM12MsgBusClientNode(data): reply s1 = '" + s1 + "'")

                        if(s1 == "$ok") {
                            RED.log.debug("RFM12MsgBusClientNode(data): reply OK")
                        } else {
                            var msg = {}

                            if(s1 == "$error") {
                                var s1 = data.slice(data.indexOf(':') + 1)
                                var s2 = s1.toString('ascii').trim()

                                node.error("Error from RFM12 controller; " + s2)

                                msg.topic   = "error"
                                msg.payload = s2
                            } else if(s1 == "$start") {
                                node.warn("RFM12 Controller started")

                                msg.topic   = "status"
                                msg.payload = "start"
                            }

                            callStatusHandlers(node, msg)
                        }
                    } else if(data[0] == '&') {         // device status
                        var posNode    = 1
                        var posSleep   = data.indexOf(':', posNode) + 1

                        var nodeB    = data.slice(posNode, posSleep - 1)
                        var sleepB   = data.slice(posSleep)

                        var nodeN    = parseInt(nodeB)
                        var sleepN   = parseInt(sleepB)

                        RED.log.debug("RFM12MsgBusClientNode(data): devstat nodeN  = '" + nodeN + "'")
                        RED.log.debug("RFM12MsgBusClientNode(data): devstat sleepN = '" + sleepN + "'")

                        for (var s in node.devicestatus) {
                            if (node.devicestatus.hasOwnProperty(s)) {
                                if (node.devicestatus[s].hasOwnProperty('0')) {
                                    if (node.devicestatus[s].nodeid == nodeN) {
                                        var n = node.devicestatus[s][0]

                                        n.handler(sleepN)
                                    }
                                }
                            }
                        }
                    } else {                            // unknown
                        RED.log.debug("RFM12MsgBusClientNode(data): unknown")
                    }
                })
            }
        }

        // receive updates from nodes
        this.subscribe = function(nodeId, service, type, dataId, callback, rfm12Node) {
            RED.log.debug("RFM12MsgBusClientNode::subscribe(): nodeId  = " + nodeId)
            RED.log.debug("RFM12MsgBusClientNode::subscribe(): service = " + service)
            RED.log.debug("RFM12MsgBusClientNode::subscribe(): type    = " + type)
            RED.log.debug("RFM12MsgBusClientNode::subscribe(): dataId  = " + dataId)

            var sub = {
                node:    nodeId,
                service: service,
                type:    type,
                dataId:  dataId,
                handler: function(msg) {
                    RED.log.debug("RFM12MsgBusClientNode::subscribe(handler): msg = " + JSON.stringify(msg))
                    callback(msg)
                }
            }

            node.subscriptions[rfm12Node.id]    = rfm12Node
            node.subscriptions[rfm12Node.id][0] = sub

            if (node.connected) {
                RED.log.debug("RFM12MsgBusClientNode::subscribe(): connected")
            } else {
                RED.log.debug("RFM12MsgBusClientNode::subscribe(): not connected")
            }
        }

        //
        this.publish = function(nodeid, service, dataid, datatype, val) {
            RED.log.debug("RFM12MsgBusClientNode::publish(): nodeid   = " + nodeid)
            RED.log.debug("RFM12MsgBusClientNode::publish(): service  = " + service)
            RED.log.debug("RFM12MsgBusClientNode::publish(): datatype = " + datatype)
            RED.log.debug("RFM12MsgBusClientNode::publish(): dataid   = " + dataid)
            RED.log.debug("RFM12MsgBusClientNode::publish(): val      = " + val)

            var d = {
                nodeid:     nodeid,
                service:    service,
                dataid:     dataid,
                datatype:   datatype,
                val:        val
            }

            if (node.connected) {
                RED.log.debug('RFM12MsgBusClientNode::publish(): connected')

                node.q.push(d, function(err) {
                    RED.log.debug('RFM12MsgBusClientNode::publish(): finished processing')
                })
            } else {
                RED.log.debug('RFM12MsgBusClientNode::publish(): not connected!')
            }
        }

        // receive debugs from controller
        this.debug_sub = function(callback, rfm12Node) {
            var sub = {
                handler: function(msg) {
                    RED.log.debug("RFM12MsgBusClientNode::debug_sub(handler): msg = " + JSON.stringify(msg))
                    callback(msg)
                }
            }

            node.debugs[rfm12Node.id]    = rfm12Node
            node.debugs[rfm12Node.id][0] = sub

            if (node.connected) {
                RED.log.debug("RFM12MsgBusClientNode::debug_sub(): connected")
            } else {
                RED.log.debug("RFM12MsgBusClientNode::debug_sub(): not connected")
            }
        }

        // receive status from controller
        this.ctrlstatus_sub = function(callback, rfm12Node) {
            var sub = {
                handler: function(msg) {
                    RED.log.debug("RFM12MsgBusClientNode::ctrlstatus_sub(handler): msg = " + JSON.stringify(msg))
                    callback(msg)
                }
            }

            node.ctrlstatus[rfm12Node.id]    = rfm12Node
            node.ctrlstatus[rfm12Node.id][0] = sub

            if (node.connected) {
                RED.log.debug("RFM12MsgBusClientNode::ctrlstatus_sub(): connected")
            } else {
                RED.log.debug("RFM12MsgBusClientNode::ctrlstatus_sub(): not connected")
            }
        }

        // receive status from device
        this.devicestatus_sub = function(callback, rfm12Node) {
            var sub = {
                handler: function(msg) {
                    RED.log.debug("RFM12MsgBusClientNode::devicestatus_sub(handler): msg = " + JSON.stringify(msg))
                    callback(msg)
                }
            }

            node.devicestatus[rfm12Node.id]    = rfm12Node
            node.devicestatus[rfm12Node.id][0] = sub

            if (node.connected) {
                RED.log.debug("RFM12MsgBusClientNode::devicestatus_sub(): connected")
            } else {
                RED.log.debug("RFM12MsgBusClientNode::devicestatus_sub(): not connected")
            }
        }

        this.q = async.queue(function(data, callback) {
            var s = ">" + data.datatype + ":" + data.nodeid + ":" + data.dataid + ":" + data.service + ":" + data.val + "\r"

            RED.log.debug("queue; s = " + s)

            node.port.write(s, callback)
        }, 20)

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            node.closing = true;

            node.port.close()

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }

            done();
        });
    }

    RED.nodes.registerType("rfm12-client", RFM12MsgBusClientNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function RFM12MsgBusDebugInNode(config) {
        RED.nodes.createNode(this, config)

        // configuration options passed by Node Red
        this.client     = config.client
        this.clientConn = RED.nodes.getNode(this.client)

        var node = this

        RED.log.debug("RFM12MsgBusDebugNode(): start")

        if (this.clientConn) {
            this.status({fill: "red", shape: "ring", text: "node-red:common.status.disconnected"})

            node.clientConn.register(node)

            this.clientConn.debug_sub(function(msg) {
                //
                // incoming event
                //
                RED.log.debug("RFM12MsgBusDebugNode(): callback; msg = " + JSON.stringify(msg))

                node.send(msg)
            }, node)

            if (this.clientConn.connected) {
                node.status({fill: "green", shape: "dot", text: "node-red:common.status.connected"})
            }
        } else {
            this.error(RED._("rfm12.errors.missing-config"))
        }

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            if (node.clientConn) {
                node.clientConn.deregister(node, done)
            }

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }
        });
    }

    RED.nodes.registerType("rfm12 debug", RFM12MsgBusDebugInNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function RFM12MsgBusCtrlStatusInNode(config) {
        RED.nodes.createNode(this, config)

        // configuration options passed by Node Red
        this.client     = config.client
        this.clientConn = RED.nodes.getNode(this.client)

        var node = this

        if (this.clientConn) {
            this.status({fill: "red", shape: "ring", text: "node-red:common.status.disconnected"})

            node.clientConn.register(this)

            this.clientConn.ctrlstatus_sub(function(msg) {
                //
                // incoming event
                //
                RED.log.debug("RFM12MsgBusCtrlStatusNode(): callback; msg = " + JSON.stringify(msg))

                node.send(msg)
            }, node)

            if (this.clientConn.connected) {
                node.status({fill: "green", shape: "dot", text: "node-red:common.status.connected"})
            }
        } else {
            this.error(RED._("rfm12.errors.missing-config"))
        }

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            if (node.clientConn) {
                node.clientConn.deregister(node, done)
            }

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }
        });
    }

    RED.nodes.registerType("rfm12 ctrl-status", RFM12MsgBusCtrlStatusInNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function RFM12MsgBusDeviceStatusInNode(config) {
        RED.nodes.createNode(this, config)

        // configuration options passed by Node Red
        this.client         = config.client
        this.nodeid         = parseInt(config.nodeid)
        this.clientConn     = RED.nodes.getNode(this.client)
        this.wdt            = parseInt(config.timeout);
        this.wdtStatus      = -1;
        this.timerHandle    = null;
        this.sendStatus     = true;

        var node = this

        if (node.clientConn.connected) {
            node.status({fill:"yellow", shape:"dot", text:"node-red:common.status.connected"});
        }

        /******************************************************************************************************************
         * functions
         *
         */
        this.disableTimer = function() {
            if (node.timerHandle) {    
                clearTimeout(node.timerHandle);
                node.timerHandle = null;    
            }
        }
          
        this.enableTimer = function() {
            if (node.timerHandle) {
                RED.log.debug("RFM12MsgBusDeviceStatusNode(enableTimer): clear timer");
                clearTimeout(node.timerHandle);
                node.timerHandle = null;
            }

            if (node.wdt > 0) {
                RED.log.debug("RFM12MsgBusDeviceStatusNode(enableTimer): node.wdt > 0");
                node.timerHandle = setTimeout(node.timerProc.bind(this), (node.wdt * 1000 * 60) * 1.1);
            } else {
                RED.log.debug("RFM12MsgBusDeviceStatusNode(enableTimer): node.wdt <= 0");
            }
        }
          
        this.resetTimer = function() {
            if (node.wdt <= 0) {
                return;
            }

            node.enableTimer();
            RED.log.debug("RFM12MsgBusDeviceStatusNode(resetTimer): node.wdtStatus = " + node.wdtStatus)

            if (node.wdtStatus != 1) {
                node.wdtStatus = 1

                var status = {
                    topic: "online",
                    payload: true
                };

                var log = {
                    topic: "log",
                    payload: {
                        device: node.nodeid.toString(),
                        type: "status",
                        msg: "Online"
                    }
                };

                if (!node.sendStatus) {
                    log = null;
                }

                node.send([status, log]);
                node.status({fill:"green", shape:"dot", text:"device online"});
            }
        }

        this.timerProc = function() {
            RED.log.debug("RFM12MsgBusDeviceStatusNode(timerproc): run; wdt = " + node.wdt);

            if (node.wdtStatus != 0) {
                node.wdtStatus = 0
    
                RED.log.debug("RFM12MsgBusDeviceStatusNode(timerproc): timeout");

                var status = {
                    topic: "online",
                    payload: false
                };

                var log = {
                    topic: "log",
                    payload: {
                        device: node.nodeid.toString(),
                        type: "status",
                        msg: "Offline"
                    }
                };

                if (!node.sendStatus) {
                    log = null;
                }

                node.send([status, log]);
                node.status({fill:"red", shape:"dot", text:"device offline"});
            }
        }

        if (this.clientConn) {
            node.enableTimer();

            node.clientConn.register(this)

            this.clientConn.devicestatus_sub(function(sleep) {
                //
                // incoming event
                //
                RED.log.debug("RFM12MsgBusDeviceStatusNode(): callback; sleep = " + sleep.toString())

                node.wdt = sleep;
                node.resetTimer();
            }, node)

            if (this.clientConn.connected) {

            }
        } else {
            this.error(RED._("rfm12.errors.missing-config"))
        }

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            node.disableTimer();

            if (node.clientConn) {
                node.clientConn.deregister(node, done)
            }

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }
        });
    }

    RED.nodes.registerType("rfm12 device-status", RFM12MsgBusDeviceStatusInNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function RFM12MsgBusValueNode(config) {
        RED.nodes.createNode(this, config)

        // configuration options passed by Node Red
        this.client     = config.client
        this.nodeid     = parseInt(config.nodeid)
        this.service    = config.service
        this.dataid     = parseInt(config.dataid)
        this.datatype   = config.datatype
        
        this.clientConn = RED.nodes.getNode(this.client)

        var node = this

        if (this.clientConn) {
            this.status({fill: "red", shape: "ring", text: "node-red:common.status.disconnected"})

            node.clientConn.register(this)

            this.clientConn.subscribe(node.nodeid, node.service, node.datatype, node.dataid, function(msg) {
                //
                // incoming event
                //
                RED.log.debug("RFM12MsgBusValueNode(): callback; msg = " + JSON.stringify(msg))

                node.send(msg)
            }, node)

            if (this.clientConn.connected) {
                node.status({fill: "green", shape: "dot", text: "node-red:common.status.connected"})
            }
        } else {
            this.error(RED._("rfm12.errors.missing-config"))
        }
        
        this.on("input", function(msg) {
            RED.log.debug("RFM12MsgBusValueNode(input): msg = ", JSON.stringify(msg))

            if (msg.hasOwnProperty("payload")) {
                var val

                if (typeof msg.payload === 'string') {
                    val = parseInt(msg.payload)
                } else if (typeof msg.payload === 'number') {
                    val = msg.payload
                } else if (typeof msg.payload === 'boolean') {
                    if (msg.payload == false) {
                        val = 0
                    } else {
                        val = 1
                    }
                } else if (typeof msg.payload === 'object') {
                    RED.log.error("payload is an object")
                    return
                } else {
                    RED.log.error("payload is invalid")
                    return
                }
                
                node.lastVal = val

                if (node.clientConn) {
                    node.clientConn.publish(node.nodeid, node.service, node.dataid, node.datatype, val)
                }
            }
        })

        /******************************************************************************************************************
         * notifications coming from Node-RED
         *
         */
        this.on('close', function(removed, done) {
            if (node.clientConn) {
                node.clientConn.deregister(node, done)
            }

            if (removed) {
                // this node has been deleted
            } else {
                // this node is being restarted
            }
        });
    }

    RED.nodes.registerType("rfm12 io", RFM12MsgBusValueNode)

	/******************************************************************************************************************
	 * 
	 *
	 */
    function callStatusHandlers(node, msg) {
        for (var s in node.ctrlstatus) {
            if (node.ctrlstatus.hasOwnProperty(s)) {
                if (node.ctrlstatus[s].hasOwnProperty('0')) {
                    var n = node.ctrlstatus[s][0]

                    n.handler(msg)
                }
            }
        }
    }
}
