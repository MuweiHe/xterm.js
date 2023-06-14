/**
 * WARNING: This demo is a barebones implementation designed for development and evaluation
 * purposes only. It is definitely NOT production ready and does not aim to be so. Exposing the
 * demo to the public as is would introduce security risks for the host.
 **/

var express = require('express');
var expressWs = require('express-ws');
var os = require('os');
var pty = require('node-pty');


const {NodeSSH} = require('node-ssh')

const ssh = new NodeSSH()
const fs = require('fs')
const path = require('path')

// Load the AWS SDK for Node.js
var AWS = require('aws-sdk');
// Set the region 
AWS.config.update({region: 'us-west-1'});

var paras = {
  KeyName: 'muwei-1-key',
}

// Create EC2 service object
var ec2 = new AWS.EC2({apiVersion: '2016-11-15'});

// Whether to use binary transport.
const USE_BINARY = os.platform() !== "win32";

function startServer() {
  var app = express();
  expressWs(app);

  var terminals = {},
    unsentOutput = {},
    temporaryDisposable = {};

  app.use('/xterm.css', express.static(__dirname + '/../css/xterm.css'));
  app.get('/logo.png', (req, res) => {
    res.sendFile(__dirname + '/logo.png');
  });

  app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
  });

  app.get('/test', (req, res) => {
    res.sendFile(__dirname + '/test.html');
  });

  app.get('/style.css', (req, res) => {
    res.sendFile(__dirname + '/style.css');
  });

  app.use('/dist', express.static(__dirname + '/dist'));
  app.use('/src', express.static(__dirname + '/src'));

  app.post('0.0.0.0:443/terminals', (req, res) => {
    const env = Object.assign({}, process.env);
    env['COLORTERM'] = 'truecolor';
    var cols = parseInt(req.query.cols),
      rows = parseInt(req.query.rows),
      term = pty.spawn(process.platform === 'win32' ? 'pwsh.exe' : 'bash', [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.platform === 'win32' ? undefined : env.PWD,
        env: env,
        encoding: USE_BINARY ? null : 'utf8'
      });

    console.log('Created terminal with PID: ' + term.pid);
    terminals[term.pid] = term;
    unsentOutput[term.pid] = '';
    temporaryDisposable[term.pid] = term.onData(function(data) {
      unsentOutput[term.pid] += data;
    });
    res.send(term.pid.toString());
    res.end();
  });

  app.post('/terminals/:pid/size', (req, res) => {
    var pid = parseInt(req.params.pid),
        cols = parseInt(req.query.cols),
        rows = parseInt(req.query.rows),
        term = terminals[pid];

    term.resize(cols, rows);
    console.log('Resized terminal ' + pid + ' to ' + cols + ' cols and ' + rows + ' rows.');
    res.end();
  });

  var params = {
    DryRun: false,
    InstanceIds: ['i-023e8c7cd29cd4d33'],
  };
  
  // Call EC2 to retrieve policy for selected bucket
  ec2.describeInstances(params, function(err, data) {
    if (err) {
      console.log("Error", err.stack);
    } else {
      console.log("Success", JSON.stringify(data));
    }
  });

  ssh.connect({
    host: '54.183.155.25',
    username: 'ec2-user',
    privateKeyPath: '/Users/mhe/documents/github/kubernetes/xterm.js/demo/muwei-1-key.pem'
  })

  app.ws('/terminals/:pid', function (ws, req) {
    var term = terminals[parseInt(req.params.pid)];
    console.log('Connected to terminal ' + term.pid);
    temporaryDisposable[term.pid].dispose();
    delete temporaryDisposable[term.pid];
    ws.send(unsentOutput[term.pid]);
    delete unsentOutput[term.pid];

    // unbuffered delivery after user input
    let userInput = false;

    // string message buffering
    function buffer(socket, timeout, maxSize) {
      let s = '';
      let sender = null;
      return (data) => {
        s += data;
        if (s.length > maxSize || userInput) {
          userInput = false;
          socket.send(s);
          s = '';
          if (sender) {
            clearTimeout(sender);
            sender = null;
          }
        } else if (!sender) {
          sender = setTimeout(() => {
            socket.send(s);
            s = '';
            sender = null;
          }, timeout);
        }
      };
    }
    // binary message buffering
    function bufferUtf8(socket, timeout, maxSize) {
      const chunks = [];
      let length = 0;
      let sender = null;
      return (data) => {
        chunks.push(data);
        length += data.length;
        if (length > maxSize || userInput) {
          userInput = false;
          socket.send(Buffer.concat(chunks));
          chunks.length = 0;
          length = 0;
          if (sender) {
            clearTimeout(sender);
            sender = null;
          }
        } else if (!sender) {
          sender = setTimeout(() => {
            socket.send(Buffer.concat(chunks));
            chunks.length = 0;
            length = 0;
            sender = null;
          }, timeout);
        }
      };
    }
    const send = (USE_BINARY ? bufferUtf8 : buffer)(ws, 3, 262144);

    // WARNING: This is a naive implementation that will not throttle the flow of data. This means
    // it could flood the communication channel and make the terminal unresponsive. Learn more about
    // the problem and how to implement flow control at https://xtermjs.org/docs/guides/flowcontrol/
    term.onData(function(data) {
      try {
        send(data);
      } catch (ex) {
        // The WebSocket is not open, ignore
      }
    });
    ws.on('message', function(msg) {
      term.write(msg);
      userInput = true;
    });
    ws.on('close', function () {
      term.kill();
      console.log('Closed terminal ' + term.pid);
      // Clean things up
      delete terminals[term.pid];
    });
  });

  var port = process.env.PORT || 443,
      host = os.platform() === 'win32' ? '127.0.0.1' : '0.0.0.0';

  console.log('App listening to ' + host + ":" + port);
  app.listen(port, host);
}

module.exports = startServer;
