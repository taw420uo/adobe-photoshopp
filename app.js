/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

(function () {
    "use strict";
    
    require("./lib/stdlog").setup({
        vendor:      "Adobe",
        application: "Adobe Photoshop CC",
        module:      "Generator"
    });


    var util = require("util"),
        config = require("./lib/config").getConfig(),
        generator = require("./lib/generator"),
        logger = require("./lib/logger"),
        Q = require("q"),
        optimist = require("optimist");


    var DEBUG_ON_LAUNCH = false,
        LOG_FILENAME = null;

    var optionParser = optimist["default"]({
        "r" : "independent",
        "m" : null,
        "p" : 49494,
        "h" : "localhost",
        "P" : "password",
        "i" : null,
        "o" : null,
        "f" : null,
        "l" : 49495,
        "n" : null
    });
    
    var argv = optionParser
        .usage("Run generator service.\nUsage: $0")
        .describe({
            "r": "launch reason, one of: independent, menu, metadata, alwayson",
            "m": "menu ID of action that should be executed immediately after startup",
            "p": "Photoshop server port",
            "h": "Photoshop server host",
            "P": "Photoshop server password",
            "i": "file descriptor of input pipe",
            "o": "file descriptor of output pipe",
            "f": "folder to search for plugins (can be used multiple times)",
            "l": "logger server port",
            "n": "filename to write the log (specifying -n witout filename uses stdout)",
            "debuglaunch": "start debugger instead of initializing (call start() to init)",
            "help": "display help message"
        }).alias({
            "r": "launchreason",
            "m": "menu",
            "p": "port",
            "h": "host",
            "P": "password",
            "i": "input",
            "o": "output",
            "f": "pluginfolder",
            "l": "loggerport",
            "n": "loggerfile"
        }).argv;
    
    if (argv.help) {
        console.log(optimist.help());
        process.exit(0);
    }

    function stop(exitCode, reason) {
        if (!reason) {
            reason = "no reason given";
        }
        console.error("Exiting with code " + exitCode + ": " + reason);
        process.exit(exitCode);
    }
    
    function startLogServer() {
        var deferred = Q.defer();
        logger.startServer(argv.loggerport, "localhost", function (err, address) {
            if (err) {
                deferred.reject(err);
            } else {
                deferred.resolve(address);
            }
        });
        return deferred.promise;
    }
    
    function setupGenerator() {
        var deferred = Q.defer();
        var theGenerator = generator.createGenerator();

        // logger.log(type, source, message, data);
        
        theGenerator.on("close", function () {
            setTimeout(function () {
                console.log("Exiting");
                stop(0, "generator close event");
            }, 1000);
        });

        var options = {};
        if ((typeof argv.input === "number" && typeof argv.output === "number") ||
            (typeof argv.input === "string" && typeof argv.output === "string")) {
            options.inputFd = argv.input;
            options.outputFd = argv.output;
            options.password = null; // No encryption over pipes
        } else if (typeof argv.port === "number" && argv.host && argv.password) {
            options.port = argv.port;
            options.host = argv.host;
            options.password = argv.password;
        }
        
        options.config = config;

        theGenerator.start(options).done(
            function () {
                logger.log("init", "app", "Generator started!", null);
                
                var folders = argv.pluginfolder;
                if (folders) {
                    if (!util.isArray(folders)) {
                        folders = [folders];
                    }
                    folders.forEach(function (f) {
                        try {
                            theGenerator.loadAllPluginsInDirectory(f);
                        } catch (e) {
                            logger.log("init", "app", "Error processing plugin directory '" + f + "'", e);
                            console.error("Error processing plugin directory %s\n", f, e);
                        }
                    });
                }

                deferred.resolve(theGenerator);
            },
            function (err) {
                deferred.reject(err);
            }
        );
        
        return deferred.promise;
    }
    
    function init() {

        // Log to file if specified
        var logFilename = LOG_FILENAME || argv.loggerfile;
        if (logFilename) {
            logger.setLogFilename(logFilename);
        }

        // Record command line arguments
        logger.log("init", "app", "node version", process.versions);
        logger.log("init", "app", "unparsed command line", process.argv);
        logger.log("init", "app", "parsed command line", argv);

        // Start async process to launch log server
        startLogServer().done(
            function (address) {
                console.log("Log server running at http://localhost:" + address.port);
            },
            function (err) {
                console.error("Error starting log server:", err);
            }
        );
                              
        // Start async process to initialize generator
        setupGenerator().done(
            function () {
                console.log("Generator initialized");
            },
            function (err) {
                stop(-3, "generator failed to initialize: " + err);
            }
        );
    }

    process.on("uncaughtException", function (err) {
        if (err) {
            if (err.stack) {
                console.error(err.stack);
            } else {
                console.error(err);
            }
        }

        stop(-1, "uncaught exception" + (err ? (": " + err.message) : "undefined"));
    });

    if (DEBUG_ON_LAUNCH || argv.debuglaunch) {
        // Set a timer that will keep our process from exiting.
        var debugStartTimeout = setInterval(function () {
            console.error("hit debugger init timeout");
        }, 100000);

        // Put a function in the global namespace that runs "init". Needs
        // to call init on the event loop so that it can be debugged (code that
        // runs from the REPL/console cannot be debugged).
        global.start = function () {
            clearTimeout(debugStartTimeout);
            process.nextTick(function () {
                init();
            });
        };

        // Start the debugger
        process._debugProcess(process.pid);
    } else {
        // Not debugging on launch, so start normally
        init();
    }

}());
