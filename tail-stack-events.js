#!/usr/bin/env node
'use strict';

const aws = require('aws-sdk');
const path = require('path');

const red = '\x1b[31m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const cyan = '\x1b[36m';
const yellow = '\x1b[33m';
const blue = '\x1b[34m';
const green = '\x1b[32m';
const gray = '\x1b[30;1m';

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

Usage: ${path.basename(__filename)} [--port port] [--procfile file] [...processes,...]

--help-h          Show this message
--stack-name,-s   Name of the stack
--die             Kill the tail when a stack completion event occurs
--follow,-f       Like "tail -f", poll forever (ignored if --die is present)
--number,-n num   Number of messages to display (max 100, defaults to 10)
--outputs         Print out the stack outputs after tailing is complete
--profile name    Name of credentials profile to use
--key key         API key to use connect to AWS
--secret secret   API secret to use to connect to AWS
--region region   The AWS region the stack is in (defaults to us-east-1)
--assume-role <ARN>   The AWS IAM role ARN to assume
`);
	console.log(`Credentials:
  By default, this script will use the default credentials you have
  configured on your machine (either from the "default" profile in
  ~/.aws/credentials or in various environment variables). If you
  wish to use a different profile, specify the name in the --profile
  option. If you with to specify the key/secret manually, use the
  --key and --secret options.`);
	console.log();

	console.log(`Examples:

  Print five previous events and successive events until stack update is complete:
    tail-stack-events -f --die -n 5 -s my-stack

  Print last 20 events for a stack in us-west-2 region
    tail-stack-events -n 20 -s my-stack --region us-west-2

  Using a different credentials profile from ~/.aws/credentials
    tail-stack-events -s my-stack --profile my-profile`);
};

let stackName = null;
let die = false;
let follow = false;
let numEvents = null;
let printOutputs = false;
let credentialsProfile = null;
let manualKey = null;
let manualSecret = null;
let region = 'us-east-1';
// while this is not fixed: https://github.com/aws/aws-sdk-js/issues/1916
// we ask for role ARN explicitly
let assumeRole = null;
// Let the program auto-detect profiles if no profile can be constructed, e.g
// because of `credential_source`.
let autoDetectProfiles = false;
let defaultProviders = [];

const parseArgs = () => {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--assume-role':
				assumeRole = args[++i];
				break;
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
			case '--profile':
				credentialsProfile = args[++i];
				break;
			case '--key':
				manualKey = args[++i];
				break;
			case '--secret':
				manualSecret = args[++i];
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

if (credentialsProfile) {
	if (manualKey || manualSecret) {
		console.error('both profile and key/secret given, ignoring key/secret');
	}
	let credentials = new aws.SharedIniFileCredentials({ profile: credentialsProfile });
	credentials.refresh((err) => {
		if (err) { 
			autoDetectProfiles = true;
			console.error(`Cannot create profile "${credentialsProfile}"! Will use auto-detect features of SDK`);
		}
	});
	defaultProviders.push(credentials);
} else if (manualKey || manualSecret) {
	aws.config.update({
		accessKeyId: manualKey,
		secretAccessKey: manualSecret
	});
}

if (autoDetectProfiles) {
	defaultProviders.push(
		function () { return new AWS.EnvironmentCredentials('AWS'); },
		function () { return new AWS.EnvironmentCredentials('AMAZON'); },
		function () { return new AWS.EC2MetadataCredentials(); }
	)
}

aws.CredentialProviderChain.defaultProviders = defaultProviders;
aws.config.update({ region: region });

if (assumeRole) {
	aws.config.credentials = new aws.ChainableTemporaryCredentials({
		params: {RoleArn: assumeRole},
		masterCredentials: aws.config.credentials
		});
}

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

		const pad0 = str => '0'.repeat(2 - str.toString().length) + str;

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
