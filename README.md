# tail-stack-events

[![NPM version](https://img.shields.io/npm/v/tail-stack-events.svg)](https://www.npmjs.com/package/tail-stack-events)

This is a convenient little CLI script (written in Node) to tail
the latest AWS CloudFormation stack events. The UI in the AWS
console kind of sucks for getting a bearing on the status of
a stack that is being updated/deleted/created, so this eases
that pain. Or something.

## Installation
Install using NPM: `npm install tail-stack-events`

Install globally if you're into that and like shoving random things
onto your PATH: `npm install -g tail-stack-events`

## Usage
If installed locally, the path will be `node_modules/.bin/tail-stack-events`.

```
  Usage: tail-stack-events [options]

  Options:

    -h, --help              output usage information
    -V, --version           output the version number
    -s,--stack-name <name>  Name of the stack
    --die                   Kill the tail when a stack completion event occurs
    -f,--follow             Like "tail -f", poll forever
    -n,--number [num]       Number of messages to display (max 100, defaults to 10)
    --outputs               Print out the stack outputs after tailing is complete
    --profile [name]        Name of credentials profile to use
    --key [key]             API key to use connect to AWS
    --secret [secret]       API secret to use to connect to AWS
    --region [region]       The AWS region the stack is in (defaults to us-east-1)

  Credentials:
    By default, this script will use the default credentials you have
    configured on your machine (either from the "default" profile in
    ~/.aws/credentials or in various environment variables). If you
    wish to use a different profile, specify the name in the --profile
    option. If you with to specify the key/secret manually, use the
    --key and --secret options.

  Examples:

    Print five previous events and successive events until stack update is complete:
      tail-stack-events -f --die -n 5 -s my-stack
    
    Print last 20 events for a stack in us-west-2 region
      tail-stack-events -n 20 -s my-stack --region us-west-2
```
