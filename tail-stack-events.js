#!/usr/bin/env node
'use strict';

const aws = require('aws-sdk');
const async = require('async');
const program = require('commander');
const chalk = require('chalk');

program
	.version(require('./package.json').version)
	.option('-s,--stack-name <name>', 'Name of the stack')
	.option('--die', 'Kill the tail when a stack completion event occurs', false)
	.option('-f,--follow', 'Like "tail -f", poll forever (ignored if --die is present)', false)
	.option('-n,--number [num]', 'Number of messages to display (max 100, defaults to 10)', 10)
	.option('--outputs', 'Print out the stack outputs after tailing is complete')
	.option('--profile [name]', 'Name of credentials profile to use')
	.option('--key [key]', 'API key to use connect to AWS')
	.option('--secret [secret]', 'API secret to use to connect to AWS')
	.option('--region [region]', 'The AWS region the stack is in (defaults to us-east-1)');

program.on('--help', () => {
	console.log(`  Credentials:
    By default, this script will use the default credentials you have
    configured on your machine (either from the "default" profile in
    ~/.aws/credentials or in various environment variables). If you
    wish to use a different profile, specify the name in the --profile
    option. If you with to specify the key/secret manually, use the
    --key and --secret options.`);

	console.log();

	console.log(`  Examples:

    Print five previous events and successive events until stack update is complete:
      tail-stack-events -f --die -n 5 -s my-stack

    Print last 20 events for a stack in us-west-2 region
      tail-stack-events -n 20 -s my-stack --region us-west-2

    Using a different credentials profile from ~/.aws/credentials
      tail-stack-events -s my-stack --profile my-profile`);
});

program.parse(process.argv);

const region = program.region || 'us-east-1';
const stackName = program.stackName;
const follow = !!program.follow;
const die = !!program.die;
const numInitialEvents = parseInt(program.number) || 5;
const printOutputs = !!program.outputs;
const credentialsProfile = program.profile;
const manualKey = program.key;
const manualSecret = program.secret;

if (!stackName) {
	console.error('a stack name must be specified');
	process.exit(1);
}

if (credentialsProfile) {
	if (manualKey || manualSecret) {
		console.error('both profile and key/secret given, ignoring key/secret');
	}

	const credentials = new aws.SharedIniFileCredentials({ profile: credentialsProfile });
	aws.config.update({ credentials: credentials });
} else if (manualKey || manualSecret) {
	aws.config.update({
		accessKeyId: manualKey,
		secretAccessKey: manualSecret
	});
}

aws.config.update({ region: region });

const cfn = new aws.CloudFormation();
let lastEvent = null;
let lastApiCall = 0;

function getRecentStackEvents(callback) {
	lastApiCall = Date.now();
	const params = {
		StackName: stackName
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
	if (/FAILED/.test(event.ResourceStatus)) {
		status = String.fromCharCode(0x2717) + ' ' + status;
		statusColor = 'red';
	} else if (/COMPLETE/.test(event.ResourceStatus)) {
		status = String.fromCharCode(0x2713) + ' ' + status;
		statusColor = 'green';
	} else {
		status = String.fromCharCode(0x231B) + ' ' + status;
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

		const pad0 = (str) => {
			return '0'.repeat(2 - str.toString().length) + str;
		};

		const time = `${pad0(ts.getHours())}:${pad0(ts.getMinutes())}:${pad0(ts.getSeconds())}`;

		return `${month} ${date} ${time}`;
	}

	const messages = [
		[15, null, formatDate(event.Timestamp)],
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

function stopTailing() {
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

		//make an API call every 3 seconds at the most
		const waitTime = Math.max(100, 3000 - (Date.now() - lastApiCall));
		setTimeout(() => {
			next();
		}, waitTime);
	});
}

async.doWhilst(printEvents, stopTailing, (err) => {
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
				console.log(`${chalk.bold(output.OutputKey)}: ${chalk.yellow(output.OutputValue)}`);
				if (output.Description) {
					console.log(`  ${chalk.gray(output.Description)}`);
				}
			});

			process.exit();
		});
	} else {
		process.exit();
	}
});
