#!/usr/bin/env node
'use strict';

const CloudFormation = require('@aws-sdk/client-cloudformation').CloudFormation;
const path = require('path');

const red = '\x1b[31m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const cyan = '\x1b[36m';
const yellow = '\x1b[33m';
const blue = '\x1b[34m';
const green = '\x1b[32m';
const gray = '\x1b[38;5;245m';

const wrapColor = (color, msg) => `${color}${msg}${reset}`;

const chalk = {
	red: wrapColor.bind(null, red),
	cyan: wrapColor.bind(null, cyan),
	bold: wrapColor.bind(null, bold),
	yellow: wrapColor.bind(null, yellow),
	green: wrapColor.bind(null, green),
	gray: wrapColor.bind(null, gray),
	blue: wrapColor.bind(null, blue),
};

const async = {
	doWhilst: (fn, test, done) => {
		const next = (err) => {
			if (err) {
				done(err);
				return;
			}

			if (!test()) {
				done();
				return;
			}

			setTimeout(() => fn(next));
		};

		fn(next);
	}
};

const usage = () => {

	console.log(`CloudFormation event tailer

Usage: ${path.basename(__filename)} [options...]

--help, -h             Show this message
--stack-name, -s name  Name of the stack
--die                  Kill the tail when a stack completion event occurs
--follow, -f           Like "tail -f", poll forever (ignored if --die is present)
--number, -n num       Number of messages to display (max 100, defaults to 10)
--outputs              Print out the stack outputs after tailing is complete
--region region        The AWS region the stack is in (defaults to whatever is
                       in your AWS profile)

Credentials:
  This will do the default AWS stuff. Set AWS_PROFILE environment variable to
  use a different profile, or update ~/.aws/credentials, or whatever the AWS
  docs say to do.

Examples:

  Print five previous events and successive events until stack update is complete:
    tail-stack-events -f --die -n 5 -s my-stack

  Print last 20 events for a stack in us-west-2 region
    tail-stack-events -n 20 -s my-stack --region us-west-2
`);
};

let stackName = null;
let die = false;
let follow = false;
let numEvents = null;
let printOutputs = false;
let region = null;

const parseArgs = () => {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--help':
			case '-h':
				usage();
				process.exit(0);
				break;
			case '--stack-name':
			case '-s':
				stackName = args[++i];
				break;
			case '--die':
				die = true;
				break;
			case '--follow':
			case '-f':
				follow = true;
				break;
			case '--number':
			case '-n':
				numEvents = parseInt(args[++i]);
				break;
			case '--outputs':
				printOutputs = true;
				break;
			case '--region':
				region = args[++i];
				break;
			default:
				console.error(`unknown option "${arg}"`);
				process.exit(1);
				break;
		}
	}
};

parseArgs();

const numInitialEvents = parseInt(numEvents) || 5;
numEvents = parseInt(numEvents) || 10;

if (!stackName) {
	console.error('a stack name must be specified');
	process.exit(1);
}

const cfnOpts = region ? { region } : {};
const cfn = new CloudFormation(cfnOpts);
let lastEvent = null;
let lastApiCall = 0;

function getRecentStackEvents(callback) {
	lastApiCall = Date.now();
	const params = {
		StackName: stackName,
	};

	cfn.describeStackEvents(params, (err, data) => {
		if (err) {
			callback(err);
			return;
		}

		let newEvents;
		if (lastEvent) {
			const lastEventIndex = data.StackEvents.findIndex((event) => {
				return lastEvent && event.EventId === lastEvent.EventId;
			});
			newEvents = data.StackEvents.slice(0, lastEventIndex === -1 ? data.StackEvents.length : lastEventIndex);
		} else {
			//only show events within the last minute
			newEvents = data.StackEvents.slice(0, numInitialEvents);
		}

		if (newEvents.length) {
			lastEvent = newEvents[0];
		}

		newEvents.reverse();

		callback(null, newEvents);
	});
}

const months = [
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function formatEvent(event) {
	let statusColor = 'blue';
	let status = event.ResourceStatus;
	if (/FAILED/.test(status)) {
		status = String.fromCharCode(0x2717) + ' ' + status;
		statusColor = 'red';
	} else if (/COMPLETE/.test(event.ResourceStatus) && !/IN_PROGRESS/.test(status)) {
		status = String.fromCharCode(0x2713) + ' ' + status;
		statusColor = 'green';
	} else {
		status = String.fromCharCode(0x2026) + ' ' + status;
	}

	function formatDate(timestamp) {
		const ts = new Date(timestamp);
		const year = ts.getFullYear();
		const month = months[ts.getMonth()];
		const date = ts.getDate();
		const oneYearAgo = new Date();
		oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

		if (ts < oneYearAgo) {
			return `${month} ${date} ${year}`;
		}

		const pad0 = str => '0'.repeat(2 - str.toString().length) + str;

		const time = `${pad0(ts.getHours())}:${pad0(ts.getMinutes())}:${pad0(ts.getSeconds())}`;

		return `${month} ${date} ${time}`;
	}

	const messages = [
		[15, 'cyan', formatDate(event.Timestamp)],
		[25, 'yellow', event.LogicalResourceId],
		[25, 'gray', event.ResourceType.replace(/^AWS::/, '')],
		[25, statusColor, status],
		[50, null, event.ResourceStatusReason]
	];

	function pad(str, maxLen) {
		const padding = maxLen - str.length;

		if (str.length > maxLen) {
			return str.substring(0, Math.floor(maxLen / 2)) +
				String.fromCharCode(0x2026) +
				str.substring(str.length - Math.ceil(maxLen / 2) + 1);
		}

		return str + ' '.repeat(padding);
	}

	const lastIndex = messages.length - 1;
	const message = messages.map((message, i) => {
		const maxLen = message[0];
		const color = message[1];
		const text = message[2] || '';

		const padded = i === lastIndex ? text : pad(text, maxLen);
		return color ? chalk[color](padded) : padded;
	});

	console.log(message.join(' '));
}

function shouldKeepTailing() {
	if (follow) {
		return true;
	}

	if (die) {
		if (lastEvent &&
			lastEvent.ResourceType === 'AWS::CloudFormation::Stack' &&
			lastEvent.LogicalResourceId === stackName &&
			/(?:COMPLETE|FAILED)$/.test(lastEvent.ResourceStatus)) {
			return false;
		}

		return true;
	}

	return false;
}

function printEvents(next) {
	getRecentStackEvents((err, events) => {
		if (err) {
			next(err);
			return;
		}

		events.forEach(formatEvent);

		if (shouldKeepTailing()) {
			//make an API call every 3 seconds at the most
			const waitTime = Math.max(100, 3000 - (Date.now() - lastApiCall));
			setTimeout(() => {
				next();
			}, waitTime);
		} else {
			next();
		}
	});
}

async.doWhilst(printEvents, shouldKeepTailing, (err) => {
	if (err) {
		console.error(err);
		process.exit(1);
	}

	if (printOutputs) {
		const params = {
			StackName: stackName
		};
		cfn.describeStacks(params, (err, result) => {
			if (err) {
				console.error(chalk.red(err.message));
				process.exit(1);
			}

			console.log();
			result.Stacks[0].Outputs.forEach((output) => {
				console.log(`${chalk.bold(output.OutputKey)}${output.Description ? ' - ' + output.Description : ''}`);
				console.log(`  ` + chalk.yellow(output.OutputValue));
			});

			process.exit();
		});
	} else {
		process.exit();
	}
});
