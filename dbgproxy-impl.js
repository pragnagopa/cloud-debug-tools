#!/usr/bin/env node

const { execSync } = require('child_process');
const https = require('https');
const net = require('net');
const path = require('path');
const WebSocketClient = require('websocket').client;
const DEBUG = typeof v8debug === 'object';
const HTTP_PLATFORM_DEBUG_PORT = 8898;
const VERSION = require('./package.json').version;

if (Number(process.version.match(/^v(\d+)\./)[1]) < 8) {
  console.error('ERROR: this application requires at least Node.js version 8, please install the LTS release from https://nodejs.org/en/download/.');
  process.exit(-1);
}

function shell(cmdline) {
  var retval = execSync(cmdline, {stdio: [process.stdin, 'pipe', process.stderr]});
  return JSON.parse(retval);
}

function requestAsync(url, options) {
  const { URL } = require('url');

  if (!(url instanceof URL)) {
    url = new URL(url);
  }
  options = options ? options : {};
  options.host = url.host;
  options.path = url.pathname + url.search;
  if (url.port) {
    options.port = url.port;
  }
  var func = null;
  switch (url.protocol) {
  case 'http:':
    func = require('http');
    break;
  case 'https:':
    func = require('https');
    break;
  }
  return new Promise(function(resolve, reject) {
    if (!func) {
      return reject(new Error(`unsupported protocol ${url.protocol}`));
    }
    func.get(options, function(res) {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      var data = null;
      res.on('data', (chunk) => {
        data = data ? data + chunk : chunk;
      });
      res.on('end', () => {
        resolve(JSON.parse(data));
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

var argv = process.argv.slice(1);
if (argv.length < 2 || argv.length > 3) {
  help();
  process.exit(-1);
}

// TODO: need to consider global Azure vs. regional data centers and Edge
var functionId = argv[1];
if (!(functionId.match(new RegExp(/^((?:(?:(?:\w[\.\-\+]?)*)\w)+)((?:(?:(?:\w[\.\-\+]?){0,62})\w)+)\.(\w{2,6})$/)))) {
  console.error(`ERROR: invalid domain name ${JSON.stringify(functionId)}.`);
  process.exit(-1);
}
var idx = functionId.indexOf('.');
var functionName = idx === -1 ? functionId : functionId.slice(0, idx);
var options = {host: '127.0.0.1', port: 8898, backlog: 1};
var wsoptions = {'Cache-Control': 'no-cache', 'Pragma': 'no-cache'};

if (argv.length === 3) {
  idx = argv[2].lastIndexOf(':');
  if (idx === -1) {
    help();
    process.exit(-1);
  }
  options.host = argv[2].slice(0, idx);
  options.port = parseInt(argv[2].slice(idx + 1));
  if (options.host === '*') {
    options.host = '0.0.0.0';
  }
}

console.log(`Function App:                 ${JSON.stringify(functionId)}`);

// check if Azure CLI has been installed
try {
  let output = execSync('az --version', {stdio: ['ignore', 'pipe', 'ignore']});
} catch(ex) {
  console.error();
  console.error('ERROR: Cannot find az command.');
  console.error('This tool requires Azure CLI, which can be installed from https://docs.microsoft.com/cli/azure/install-azure-cli.');
  process.exit(-1);
}

process.stdout.write(`Subscription:                 `);
var currentSubscription = shell('az account show');
console.log(JSON.stringify(currentSubscription.name), `(ID = ${JSON.stringify(currentSubscription.id)})`);
process.stdout.write(`Resource Group:               `);
var arrFunctionApps = shell('az functionapp list --query "[].{name: name, resourceGroup: resourceGroup}"');
var objFunctionApps = {};
for (var i = 0; i < arrFunctionApps.length; i++) {
  objFunctionApps[arrFunctionApps[i].name.toLowerCase()] = arrFunctionApps[i];
}

if (!objFunctionApps.hasOwnProperty(functionName.toLowerCase())) {
  console.error();
  console.error(`ERROR: cannot find ${JSON.stringify(functionName)} under current subscription ${JSON.stringify(currentSubscription.name)}.`);
  console.error('If you want to switch to another subscription, try "az account set".');
  process.exit(-1);
}

var resourceGroup = objFunctionApps[functionName.toLowerCase()].resourceGroup;
console.log(JSON.stringify(resourceGroup));

process.stdout.write(`Fetch debug settings:         `);
var objCredential = shell(`az functionapp deployment list-publishing-profiles --resource-group ${resourceGroup} --name ${functionName} --query "[?contains(publishMethod, 'MSDeploy')].{name: userName, password: userPWD}"`)[0];

var bRemoteDebugEnabled = Boolean(shell(`az webapp config appsettings list --resource-group ${resourceGroup} --name ${functionName} --query "[?contains(name, 'HTTP_PLATFORM_DEBUG_PORT')]"`).length);
console.log(`done`);

if (!bRemoteDebugEnabled) {
  process.stdout.write(`Switch to 64bit:              `);
  shell(`az resource update --id /subscriptions/${currentSubscription.id}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionName}/config/web --set properties.use32BitWorkerProcess=false`);
  console.log(`done`);

  process.stdout.write(`Enable WebSocket:             `);
  shell(`az resource update --id /subscriptions/${currentSubscription.id}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionName}/config/web --set properties.webSocketsEnabled=true`);
  console.log(`done`);

  process.stdout.write(`Set JAVA_OPTS:                `);
  shell(`az webapp config appsettings set --resource-group ${resourceGroup} --name ${functionName} --settings JAVA_OPTS="-Djava.net.preferIPv4Stack=true -Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${HTTP_PLATFORM_DEBUG_PORT}"`);
  console.log(`done`);

  process.stdout.write(`Set HTTP_PLATFORM_DEBUG_PORT: `);
  shell(`az webapp config appsettings set --resource-group ${resourceGroup} --name ${functionName} --settings HTTP_PLATFORM_DEBUG_PORT=${HTTP_PLATFORM_DEBUG_PORT}`);
  console.log(`done`);
}

console.log(`Remote debugging is enabled on ${JSON.stringify(functionId)}`);

(async function keepalive() {
  try {
    let accountAccessToken = shell(`az account get-access-token`).accessToken;
    let functionAccessToken = await requestAsync(
      `https://${functionName}.scm.azurewebsites.net/api/functions/admin/token`,
      { headers: { 'Authorization': `Bearer ${accountAccessToken}` }});
    let functionMasterKey = await requestAsync(
      `https://${functionName}.azurewebsites.net/admin/host/systemkeys/_master`,
      { headers : { 'Authorization': `Bearer ${functionAccessToken}` }});
    let status = await requestAsync(
      `https://${functionName}.azurewebsites.net/admin/host/status?code=${functionMasterKey.value}`);
    console.log(`[Heartbeat] ${status.state}`);
    setTimeout(keepalive, 60 * 1000 /* 60 seconds */);
  } catch(ex) {
    setTimeout(keepalive, 5 * 1000 /* 5 seconds */);
  }
})();

function help() {
  console.log([
    'Usage: dbgproxy <FQDN> [<binding host>:<port>]', // TODO: [<affinity cookie>]
    '',
    'Sample:',
    '',
    '    dbgproxy my-function.azurewebsites.net',
    '    dbgproxy my-function.azurewebsites.net *:8000',
    '    dbgproxy my-function.azurewebsites.net 0.0.0.0:8898',
    '    dbgproxy my-function.azurewebsites.net 127.0.0.1:8898',
    '    dbgproxy my-function.azurewebsites.net localhost:8898',
    '',
  ].join('\r\n'));
  console.log('dbgproxy@' + VERSION, path.resolve(__dirname, 'dbgproxy'));
}

var server = net.createServer();
var wsclient = null;
var wsconnection = null;

function wscleanup() {
  if (wsclient) {
    wsclient.abort();
    wsclient = null;
  }
  if (wsconnection) {
    wsconnection.close();
    wsconnection = null;
  }
}

server.on('connection', function(socket) {
  if (wsclient) {
    console.log(`[Server] client rejected ${socket.remoteAddress}:${socket.remotePort}`);

    socket.destroy();
    return;
  } else {
    console.log(`[Server] client connected ${socket.remoteAddress}:${socket.remotePort}`);
    socket.pause();

    wsclient = new WebSocketClient();

    wsclient.on('connect', function(connection) {
      console.log('[WebSocket] client connected');
      wsconnection = connection;

      connection.on('close', function() {
        console.log('[WebSocket] connection closed');
        wscleanup();
        socket.destroy();
      });

      connection.on('error', function(error) {
        console.log('[WebSocket]', error.toString());
        wscleanup();
        socket.destroy();
      });

      connection.on('message', function(message) {
        if (DEBUG) {
          console.log('[Download]', message.binaryData);
        }
        socket.write(message.binaryData);
      });
      socket.resume();
    });

    wsclient.on('connectFailed', function(error) {
      console.log('[WebSocket]', error.toString());
      wscleanup();
      socket.destroy();
    });

    wsclient.connect(`wss://${functionName}.scm.azurewebsites.net/DebugSiteExtension/JavaDebugSiteExtension.ashx`, null, null, wsoptions, {auth: objCredential.name + ':' + objCredential.password});
  }

  socket.on('data', function(data) {
    if (DEBUG) {
      console.log('[Upload]', data);
    }
    wsconnection.send(data);
  });

  socket.on('end', function() {
    console.log(`[Server] client disconnected ${socket.remoteAddress}:${socket.remotePort}`);
    wscleanup();
  });

  socket.on('error', function(err) {
    console.log('[Server]', err.toString());
    wscleanup();
    socket.destroy();
  });
});

server.on('listening', () => {
  var address = server.address().address;
  var port = server.address().port;
  console.log(`[Server] listening on ${address}:${port}`);
  if (address === '0.0.0.0') {
    address = '127.0.0.1';
  }
  console.log();
  console.log(`Now you should be able to debug using "jdb -connect com.sun.jdi.SocketAttach:hostname=${address},port=${port}"`);
});

server.listen(options);
