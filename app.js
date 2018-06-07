var assert = require('assert');
var crypto = require('crypto');
var program = require('commander');
var path = require('path');
var fs = require('fs');
var async = require('async');
var tracer = require('tracer');
var Logger = require('./src/logger');
var init = require('./src/init');
var initRuntime = require('./src/runtime')

function verifyGenesisBlock(scope, block) {
  try {
    var payloadHash = crypto.createHash('sha256');

    for (var i = 0; i < block.transactions.length; ++i) {
      var trs = block.transactions[i];
      var bytes = scope.base.transaction.getBytes(trs);
      payloadHash.update(bytes);
    }
    var id = scope.base.block.getId(block);
    assert.equal(payloadHash.digest().toString('hex'), block.payloadHash, 'Unexpected payloadHash');
    assert.equal(id, block.id, 'Unexpected block id');
    // assert.equal(id, '11839820784468442760', 'Block id is incorrect');
  } catch (e) {
    throw (e)
  }
}

function main() {
  process.stdin.resume();

  var version = '1.4.0-beta';
  program
    .version(version)
    .option('-c, --config <path>', 'Config file path')
    .option('-p, --port <port>', 'Listening port number')
    .option('-a, --address <ip>', 'Listening host name or ip')
    .option('-g, --genesisblock <path>', 'Genesisblock path')
    .option('-x, --peers [peers...]', 'Peers list')
    .option('-l, --log <level>', 'Log level')
    .option('-d, --daemon', 'Run asch node as daemon')
    .option('-e, --execute <path>', 'exe')
    .option('--chains <dir>', 'Chains directory')
    .option('--base <dir>', 'Base directory')
    .option('--data <dir>', 'Data directory')
    .parse(process.argv);

  var baseDir = program.base || './';

  var appConfigFile = path.join(baseDir, 'config.json');
  if (program.config) {
    appConfigFile = path.resolve(process.cwd(), program.config);
  }
  var appConfig = JSON.parse(fs.readFileSync(appConfigFile, 'utf8'));

  var pidFile = appConfig.pidFile || path.join(baseDir, 'asch.pid');
  if (fs.existsSync(pidFile)) {
    console.log('Failed: asch server already started');
    return;
  }


  if (!appConfig.chain.masterpassword) {
    var randomstring = require("randomstring");
    appConfig.chain.masterpassword = randomstring.generate({
      length: 12,
      readable: true,
      charset: 'alphanumeric'
    });
    fs.writeFileSync(appConfigFile, JSON.stringify(appConfig, null, 2), "utf8");
  }

  appConfig.version = version;
  appConfig.baseDir = baseDir;
  appConfig.dataDir = program.data || path.resolve(baseDir, 'data')
  appConfig.buildVersion = '18:07:38 07/06/2018'
  appConfig.netVersion = process.env.NET_VERSION || 'localnet';
  appConfig.publicDir = path.join(baseDir, 'public', 'dist');
  appConfig.chainDir = program.chains || path.join(baseDir, 'chains')

  global.Config = appConfig;

  var genesisblockFile = path.join(baseDir, 'genesisBlock.json');
  if (program.genesisblock) {
    genesisblockFile = path.resolve(process.cwd(), program.genesisblock);
  }
  var genesisblock = JSON.parse(fs.readFileSync(genesisblockFile, 'utf8'));

  if (program.port) {
    appConfig.port = program.port;
  }

  if (program.address) {
    appConfig.address = program.address;
  }

  if (program.peers) {
    if (typeof program.peers === 'string') {
      appConfig.peers.list = program.peers.split(',').map(function (peer) {
        peer = peer.split(":");
        return {
          ip: peer.shift(),
          port: peer.shift() || appConfig.port
        };
      });
    } else {
      appConfig.peers.list = [];
    }
  }

  if (appConfig.netVersion === 'mainnet') {
    var seeds = [
      757137132,
      1815983436,
      759980934,
      759980683,
      1807690192,
      1758431015,
      1760474482,
      1760474149,
      759110497,
      757134616
    ];
    var ip = require('ip');
    for (var i = 0; i < seeds.length; ++i) {
      appConfig.peers.list.push({ ip: ip.fromLong(seeds[i]), port: 80 });
    }
  }

  if (program.log) {
    appConfig.logLevel = program.log;
  }

  var protoFile = path.join(baseDir, 'proto', 'index.proto');
  if (!fs.existsSync(protoFile)) {
    console.log('Failed: proto file not exists!');
    return;
  }

  if (program.daemon) {
    console.log('Asch server started as daemon ...');
    require('daemon')({ cwd: process.cwd() });
    fs.writeFileSync(pidFile, process.pid, 'utf8');
  }

  var logger = new Logger({
    filename: appConfig.logFile || path.join(baseDir, 'logs', 'debug.log'),
    echo: program.deamon ? null : appConfig.logLevel,
    errorLevel: appConfig.logLevel
  });
  //var logger = tracer.dailyfile({ root: path.join(baseDir, 'logs'), maxLogFiles: 10, allLogsFileName: 'debug'})
  //logger.setLevel = tracer.setLevel

  var options = {
    appConfig: appConfig,
    genesisblock: genesisblock,
    logger: logger,
    protoFile: protoFile
  };

  if (program.reindex) {
    appConfig.loading.verifyOnLoading = true;
  }

  global.featureSwitch = {}
  global.state = {};

  init(options, function (err, scope) {
    if (err) {
      scope.logger.fatal(err);
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(1);
      return;
    }
    process.once('cleanup', function () {
      scope.logger.info('Cleaning up...');
      async.eachSeries(scope.modules, function (module, cb) {
        if (typeof (module.cleanup) == 'function') {
          module.cleanup(cb);
        } else {
          setImmediate(cb);
        }
      }, function (err) {
        if (err) {
          scope.logger.error('Error while cleaning up', err);
        } else {
          scope.logger.info('Cleaned up successfully');
        }
        (async function () {
          try {
            await app.sdb.close()
          } catch (e) {
            scope.logger.error('failed to close sdb', e)
          }
        })()

        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
        }
        process.exit(1);
      });
    });

    process.once('SIGTERM', function () {
      process.emit('cleanup');
    })

    process.once('exit', function () {
      scope.logger.info('process exited');
    });

    process.once('SIGINT', function () {
      process.emit('cleanup');
    });

    process.on('uncaughtException', function (err) {
      // handle the error safely
      scope.logger.fatal('uncaughtException', { message: err.message, stack: err.stack });
      process.emit('cleanup');
    });
    process.on('unhandledRejection', function (err) {
      // handle the error safely
      scope.logger.error('unhandledRejection', err);
      process.emit('cleanup');
    });

    if (typeof gc !== 'undefined') {
      setInterval(function () {
        gc();
      }, 60000);
    }
    verifyGenesisBlock(scope, scope.genesisblock.block);

    options.library = scope;
    (async function () {
      try {
        await initRuntime(options)
      } catch (e) {
        logger.error('init runtime error: ', e)
        process.exit(1)
        return
      }
      if (program.execute) {
        // only for debug use
        // require(path.resolve(program.execute))(scope);
      }

      scope.bus.message('bind', scope.modules);
      global.modules = scope.modules

      scope.logger.info('Modules ready and launched');
      if (!scope.config.publicIp) {
        scope.logger.warn('Failed to get public ip, block forging MAY not work!');
      }
    })()
  });
}

main();
