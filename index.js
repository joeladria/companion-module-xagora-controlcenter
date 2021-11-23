const instance_skel = require('../../instance_skel')
const mqtt = require('mqtt')
const debounceFn = require('debounce-fn')
const objectPath = require('object-path')



class mqtt_instance extends instance_skel {
	constructor(system, id, config) {
		super(system, id, config)

		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		this.debounceUpdateInstanceVariables = debounceFn(this._updateInstanceVariables, {
			wait: 100,
			immediate: false,
		})
	}

	static GetUpgradeScripts() {
		return [
			instance_skel.CreateConvertToBooleanFeedbackUpgradeScript({ mqtt_value: true }),
			// future scripts here
		]
	}

	updateConfig(config) {
		this.config = config

		this._initMqtt()
	}

	init() {
		this._initActionDefinitions()
		this._initFeedbackDefinitions()
		this._initMqtt()
	}

	_resubscribeToTopics() {
		// Unsubscribe from everything
		this.mqtt_topic_subscriptions.forEach((topic) => {
			this.mqttClient.unsubscribe(topic, (err) => {
				if (!err) {
					this.debug(`Successfully unsubscribed from topic: ${topic}`)
					return
				}

				this.debug(`Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
			})
		})
		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		// And then subscribe
		this.subscribeFeedbacks()
	}

	_initFeedbackDefinitions() {
		this.setFeedbackDefinitions({
			mqtt_variable: {
				label: 'Update variable with value from MQTT topic',
				description:
					'Receive messages from the MQTT broker and set the value to a variable. Variables can be used on any button.',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Variable',
						id: 'variable',
						default: '',
					},
				],
				callback: () => {
					// Nothing to do, as this feeds a variable
				},
				subscribe: (feedback) => {
					const subData = {
						variableName: feedback.options.variable,
						subpath: feedback.options.subpath,
					}
					this._subscribeToTopic(feedback.options.subscribeTopic, feedback.id, 'mqtt_variable', subData)
					this.debounceUpdateInstanceVariables()

					// Update it if we have a cached value
					const message = this.mqtt_topic_value_cache.get(feedback.options.subscribeTopic)
					if (message !== undefined) {
						this._updateFeedbackVariables([[feedback.options.subscribeTopic, subData]])
					}
				},
				unsubscribe: (feedback) => {
					this._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
					this.debounceUpdateInstanceVariables()
				},
			},
			mqtt_value: {
				type: 'boolean',
				label: 'Change colors from MQTT topic value',
				description: 'If the specified MQTT topic value matches this condition, change color of the bank.',
				style: {
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(0, 255, 0),
				},
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
					},
					{
						type: 'dropdown',
						label: 'Comparison',
						id: 'comparison',
						default: 'eq',
						choices: [
							{ id: 'eq', label: '=' },
							{ id: 'ne', label: '!=' },
							{ id: 'lt', label: '<' },
							{ id: 'lte', label: '<=' },
							{ id: 'gt', label: '>' },
							{ id: 'gte', label: '>=' },
						],
					},
				],
				callback: (feedback) => {
					let value = this.mqtt_topic_value_cache.get(feedback.options.subscribeTopic)
					if (value !== undefined) {
						if (feedback.options.subpath) {
							value = objectPath.get(JSON.parse(value), feedback.options.subpath)
						}

						const targetValue = feedback.options.value
						const checks = {
							eq: value == targetValue,
							ne: value != targetValue,
							lt: value < targetValue,
							lte: value <= targetValue,
							gt: value > targetValue,
							gte: value >= targetValue,
						}
						return checks[feedback.options.comparison] || false
					}

					return false
				},
				subscribe: (feedback) => {
					this._subscribeToTopic(feedback.options.subscribeTopic, feedback.id, 'mqtt_value')
				},
				unsubscribe: (feedback) => {
					this._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
				},
			},
		})
	}

	_subscribeToTopic(topic, feedbackId, feedbackType, data) {
		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length === 0) {
			this.mqttClient.subscribe(topic, (err) => {
				if (!err) {
					this.debug(`Successfully subscribed to topic: ${topic}`)
					return
				}

				this.debug(`Failed to subscribe to topic: ${topic}. Error: ${err}`)
			})
		}
		if (!subscriptions[feedbackId]) {
			subscriptions[feedbackId] = { ...data, type: feedbackType }
			this.mqtt_topic_subscriptions.set(topic, subscriptions)
		}
	}
	_unsubscribeToTopic(topic, feedbackId) {
		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length !== 0 && subscriptions[feedbackId]) {
			delete subscriptions[feedbackId]
			this.mqtt_topic_subscriptions.set(topic, subscriptions)

			if (Object.keys(subscriptions).length === 0) {
				this.mqttClient.unsubscribe(topic, (err) => {
					if (this.mqtt_topic_value_cache.has(topic) && !this.mqtt_topic_subscriptions.has(topic)) {
						// Ensure cached value is pruned
						this.mqtt_topic_value_cache.delete(topic)
					}

					if (!err) {
						this.debug(`Successfully unsubscribed from topic: ${topic}`)
						return
					}

					this.debug(`Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
				})
			}
		}
	}

	config_fields() {
		return [
			{
				type: 'textinput',
				id: 'broker_ip',
				width: 4,
				label: 'Broker IP',
				regex: this.REGEX_IP,
			},
			{
				type: 'textinput',
				id: 'datastore',
				width: 12,
				label: 'data store (without port)',
			},
			{
				type: 'textinput',
				id: 'topic',
				width: 6,
				label: 'project topic (id)',
			},
		]
	}

	destroy() {
		if (this.mqttClient && this.mqttClient.connected) {
			this.mqttClient.disconnect()
		}
	}

	_initActionDefinitions() {
		this.setActions({
			publish: {
				label: 'Publish Message',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'topic',
						default: '',
						width: 12,
					},
					{
						type: 'textinput',
						label: 'Payload',
						id: 'payload',
						default: '',
						width: 12,
					},
					{
						type: 'number',
						label: 'QoS',
						id: 'qos',
						default: 0,
						width: 4,
						min: 0,
						max: 2,
					},
					{
						type: 'checkbox',
						label: 'Retain?',
						id: 'retain',
						default: false,
						width: 4,
					},
				],
				callback: (action) => {
					const { retain, topic, qos, payload } = action.options
					this._publishMessage(topic, payload, qos, retain)
				},
			},
			execute: {
				label: 'Execute Taskflow',
				options: [
					{
						type: 'dropdown',
						label: 'Taskflow Name',
						id: 'taskflow',
						default: '',
						width: 12,
					}
				],
				callback: (action) => {
					const { retain, topic, qos, payload } = action.options
					this._publishMessage(topic, payload, qos, retain)
				},
			},
		})
	}

	_initMqtt() {
		this.mqttClient = mqtt.connect(this.config.protocol + this.config.broker_ip, {
			username: this.config.user,
			password: this.config.password,
		})
		this._resubscribeToTopics()

		this.mqttClient.on('connect', () => {
			this.status(this.STATUS_OK)
		})

		this.mqttClient.on('error', (error) => {
			this.status(this.STATUS_ERROR, error)
		})

		this.mqttClient.on('offline', () => {
			this.status(this.STATUS_WARNING, 'Offline')
		})

		// this.mqttClient.on('packetreceive', packet => {
		// 	this.debug('MQTT', packet)
		// });

		this.mqttClient.on('message', (topic, message) => {
			try {
				if (topic) {
					this._handleMqttMessage(topic, message ? message.toString() : '')
				}
			} catch (e) {
				this.log('error', `Handle message faaailed: ${e.toString()}`)
			}
		})
	}

	_publishMessage(topic, payload, qos, retain) {
		this.debug('Sending MQTT message', [topic, payload])

		this.mqttClient.publish(topic, payload, { qos: qos, retain: retain })
	}

	_executeTaskflow(taskflow) {
		// 		Execute a taskflow
// 
// 
		this.debug('Attempting to execute taskflow', taskflow)
		params = {"jsonrpc": "2.0","method": "TaskFlow.Execute","params": {"internalName": taskflow,"clienId": "companion","rpcId": 4},"id": 4}
		url = 'http://' + datstore + ':3030/sc-datastore/projectData/taskFlow';


// Example of answer
// {
// 	"jsonrpc": "2.0",
// 	"id": 4,
// 	"result": {
// 		"code": 55555,
// 		"message": "Task Flow execution command send to Commander."
// 	}
// }






// Notification of end of execution of a taskflow
//    For the moment, this notification can only been received through a MQTT topic: computer/+/software/sc-task-engine/showcontrol/taskFlow_status

// {
// 	"jsonrpc": "2.0",
// 	"id": "26817de3-fc45-18d0-6d58-c4a1e1f21bb1",
// 	"result": {
// 		"method": "Task.Execute",
// 		"code": 0,
// 		"message": "Task executed successfully",
// 		"data": "OK"
// 	}
// }


		this.mqttClient.publish(topic, payload, { qos: qos, retain: retain })
	}

	_handleMqttMessage(topic, message) {
		this.debug('MQTT message received:', {
			topic: topic,
			message: message,
		})

		const subscriptions = this.mqtt_topic_subscriptions.get(topic)
		if (subscriptions) {
			this.mqtt_topic_value_cache.set(topic, message)

			const variablesToUpdate = []
			const feedbackIdsToUpdate = []

			for (const [id, data] of Object.entries(subscriptions)) {
				if (data.type === 'mqtt_variable') {
					variablesToUpdate.push([topic, data])
				} else {
					feedbackIdsToUpdate.push(id)
				}
			}

			this.checkFeedbacksById(...feedbackIdsToUpdate)
			this._updateFeedbackVariables(variablesToUpdate)
		}
	}

	_updateFeedbackVariables(variables) {
		const newValues = {}

		for (const [topic, data] of variables) {
			let msgValue = this.mqtt_topic_value_cache.get(topic)
			if (msgValue) {
				if (data.subpath) {
					msgValue = objectPath.get(JSON.parse(msgValue), data.subpath)
				}

				newValues[data.variableName] = typeof msgValue === 'object' ? JSON.stringify(msgValue) : msgValue
			}
		}

		this.setVariables(newValues)
	}

	_updateInstanceVariables() {
		// query for taskflows
		// curl -H 'Content-Type: application/json' -d '{"jsonrpc": "2.0","method": "TaskFlow.Array","params": {"projectIdentifier": "test_project", "autoPopulate": true},"id": 2}' http://cc-test-01:3030/sc-datastore/projectData/taskFlow
		// returns taskflow array
		const vars = []

		this.mqtt_topic_subscriptions.forEach((uses, key) => {
			Object.values(uses).forEach((use) => {
				if (use.type === 'mqtt_variable') {
					vars.push({
						label: `MQTT value from topic: ${key}`,
						name: use.variableName,
					})
				}
			})
		})

		this.debug('Refreshing variable definitions:', vars)
		this.setVariableDefinitions(vars)
	}
}

exports = module.exports = mqtt_instance
