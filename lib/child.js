var QUnit = require('qunitjs'),
    path = require('path'),
    _ = require('underscore'),
    trace = require('tracejs').trace,
    coverage = require('./coverage'),
    generators = require('./generators'),
    co = require('co');

// cycle.js: This file contains two functions, JSON.decycle and JSON.retrocycle,
// which make it possible to encode cyclical structures and dags in JSON, and to
// then recover them. JSONPath is used to represent the links.
// http://GOESSNER.net/articles/JsonPath/
require('../support/json/cycle');

var options = JSON.parse(process.argv[2]), currentModule, currentTest;

function getModuleName(module) {
  if (typeof module == 'undefined') {
    return;
  }
  if (typeof module == 'string') {
    return path.basename(module, '.js');
  } else {
    return path.basename(module.path, '.js');
  }
}

if (!!options.code) {
    currentModule = getModuleName(options.code.path);
} else {
    // Script-based tests could contain code and test. In that case
    // code can be not set, and the module name can be taken from the test name itself.
	currentModule = '<none>';
}

process.on('uncaughtException', function (err) {
	console.log('Exception: ' + err.message);
	console.log('Stack: ' + err.stack);
    if (QUnit.config.current) {
        QUnit.ok(false, 'Test threw unexpected exception: ' + err.message);
        QUnit.start();
    }
    process.send({
        event: 'uncaughtException',
        data: {
            message: err.message,
            stack: err.stack
        }
    });
});

QUnit.init();
QUnit.config.autostart = false;
QUnit.config.pageLoaded = true;

// make qunit api global, like it is in the browser
_.extend(global, QUnit);

// as well as the QUnit variable itself
global.QUnit = QUnit;

// Caches between require aliases and real module instance
var aliasCache = {};

/**
 * Require a resource.
 * @param {Object} res
 */
function _require(res, addToGlobal) {
	var exports;
	if (typeof res === 'string') {
    	exports = require(res);
	}
	else {
        exports = require(res.path.replace(/\.js$/, ''));
        // Store the alias
        if (res.alias) {
			//console.log('Aliasing ' + res.path.replace(/\.js$/, '') + ' with ' + res.alias);
            aliasCache[res.alias] = exports;
        }
	}

    if (addToGlobal) {
        // resource can define 'namespace' to expose its exports as a named object
        if (res.namespace) {
            global[res.namespace] = exports;
        } else {
            _.extend(global, exports);
        }
    }
}

/**
 * Callback for each started test.
 * @param {Object} test
 */
QUnit.testStart(function(test) {
    // currentTest is undefined while first test is not done yet
    currentTest = test.name;

    // use last module name if no module name defined
    currentModule = getModuleName(test.module) || currentModule;
});

/**
 * Callback for each assertion.
 * @param {Object} data
 */
QUnit.log(function(data) {
    data.test = QUnit.config.current.testName;
    data.module = currentModule;
    process.send({
        event: 'assertionDone',
        data: JSON.decycle(data)
    });
});

/**
 * Callback for one done test.
 * @param {Object} test
 */
QUnit.testDone(function(data) {
    // use last module name if no module name defined
    data.module = getModuleName(data.module) || currentModule;
    process.send({
        event: 'testDone',
        data: data
    });
});

/**
 * Callback for all done tests in the file.
 * @param {Object} res
 */
QUnit.done(_.debounce(function(data) {
    data.coverage = global.__coverage__;

    process.send({
        event: 'done',
        data: data
    });
}, 1000));

if (generators.support) {
    var test = QUnit.test;

    /**
     * Support generators.
     */
    global.test = QUnit.test = function(testName, expected, callback, async) {
        var fn;

        if (arguments.length === 2) {
            callback = expected;
            expected = null;
        }

        if (generators.isGeneratorFn(callback)) {
            fn = function(assert) {
                stop();
                co(callback).call(this, assert, function(err) {
                    if (err) return console.log(err.stack)
                    start();
                });
            };
        } else {
            fn = callback;
        }

        return test.call(this, testName, expected, fn, async);
    };
}

/**
 * Provide better stack traces
 */
var error = console.error;
console.error = function(obj) {
    // log full stacktrace
    if (obj && obj.stack) {
        obj = trace(obj);
    }

    return error.apply(this, arguments);
};

if (options.coverage) {
    coverage.instrument(options);
}

// require deps
options.deps.forEach(function(dep) {
    _require(dep, true);
});


// Before requiring the code, store require aliases
function installRequireHooks() {
    // require.extensions seems to expose access to the wanted require function
    // Solution currently used by proxyquire: https://github.com/thlorenz/proxyquire
    // WARNING: node declare this as deprecated!

  Object.keys(require.extensions).forEach(function(extension) {
    var originalExtension = require.extensions[extension];

    // Override the default handler for the requested file extension
    require.extensions[extension] = function(module, filename) {
      // Override the require method for this module
      var origF = module.require;
      module.require = function(path) {
        // Check for an alias to exists

        if (aliasCache[path]) {
          return aliasCache[path];
        } else {
          // Old call
          return origF.apply(module, arguments);
        }
      };

      return originalExtension(module, filename);
    };
  });
}

installRequireHooks();


// require code, if one
if (!!options.code) {
	_require(options.code, true);
}

// require tests
options.tests.forEach(function(test) {
    QUnit.module(test);
    _require(test, true);
});

QUnit.start();
