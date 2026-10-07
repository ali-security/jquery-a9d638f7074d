/*
 * PhantomJS runner for the jQuery QUnit suite (test/index.html).
 *
 * Usage:
 *   phantomjs test/phantomjs-qunit-runner.js <url> [timeout-seconds]
 *   e.g. phantomjs test/phantomjs-qunit-runner.js http://127.0.0.1:8000/test/index.html
 *
 * The page must be served over HTTP by a PHP-capable server (the ajax tests
 * call test/data/*.php), and dist/jquery*.js must already be built (`grunt`).
 *
 * Prints one line per test:
 *   PASS <module> :: <test> (<n> assertions)
 *   FAIL <module> :: <test> (<failed> of <n> assertions failed)
 *       - <failed assertion message> (expected / actual / source)
 *   SKIP <module> :: <test> -- <reason>   (EXCLUDED_TESTS below; never executed)
 * followed by a summary line:
 *   Tests: X passed, Y failed, Z skipped, T total; assertions: A passed, B failed
 * and exits 1 when any test failed, no test ran, an EXCLUDED_TESTS entry
 * matched no registered test, or the global timeout hit.
 *
 * ES5 only: PhantomJS 2.1.1 does not support let/const/arrow functions.
 */
/* global phantom, require, window, document */
( function() {
	"use strict";

	var system = require( "system" ),
		webpage = require( "webpage" ),

		url = system.args[ 1 ],
		timeoutSeconds = parseInt( system.args[ 2 ], 10 ) || 15 * 60,

		page,
		opened = false,
		finished = false,
		hooked = false,
		doneDetails = null,
		doneTimer = null,
		domCompletedAt = 0,
		startedAt = new Date().getTime(),

		// Tests excluded from the PhantomJS run. Only deterministic
		// PhantomJS 2.1.1 / QtWebKit engine behaviours belong here, keyed by
		// QUnit module + exact test name, each with the reason. Excluded tests
		// are dropped when they are registered (test()/asyncTest()), so they
		// never execute. The run fails if an entry matches no registered test,
		// so the list cannot silently go stale.
		EXCLUDED_TESTS = [
			{
				module: "core",
				name: "jQuery.parseXML",
				reason: "PhantomJS 2.1.1's DOMParser does not report invalid XML"
			},
			{
				module: "core",
				name: "document ready when jQuery loaded asynchronously (#13655)",
				reason: "fails on every PhantomJS run; ready-state timing in QtWebKit"
			},
			{
				module: "ajax",
				name: "jQuery.ajax() - contentType",
				reason: "QtWebKit drops a Content-Type request header on a GET with no body"
			}
		],

		// Results collected through the QUnit callbacks
		results = [],
		skipped = [],
		currentTest = null,
		currentFailures = [];

	function print( line ) {
		system.stdout.writeLine( line );
	}

	function exit( code ) {
		if ( finished ) {
			return;
		}
		finished = true;

		// Exiting synchronously from inside a page callback can crash
		// PhantomJS 2.x; leave the callback first.
		window.setTimeout( function() {
			try {
				if ( page ) {
					page.close();
				}
			} catch ( e ) {}
			phantom.exit( code );
		}, 0 );
	}

	function testLabel( module, name ) {
		return ( module || "(no module)" ) + " :: " + name;
	}

	function printTest( test ) {
		var i, failure;

		if ( test.failed > 0 ) {
			print( "FAIL " + testLabel( test.module, test.name ) + " (" +
				test.failed + " of " + test.total + " assertions failed)" );
			for ( i = 0; i < test.failures.length; i++ ) {
				failure = test.failures[ i ];
				print( "    - " + ( failure.message || "(no message)" ) );
				if ( failure.hasExpected ) {
					print( "      expected: " + failure.expected );
					print( "      actual:   " + failure.actual );
				}
				if ( failure.source ) {
					print( "      source:   " + String( failure.source ).split( "\n" )[ 0 ] );
				}
			}
		} else {
			print( "PASS " + testLabel( test.module, test.name ) + " (" +
				test.total + " assertions)" );
		}
	}

	function summarize( list, reason ) {
		var i, j, matched,
			testsPassed = 0,
			testsFailed = 0,
			assertionsPassed = 0,
			assertionsFailed = 0,
			failedTests = [],
			staleExclusions = [];

		for ( i = 0; i < EXCLUDED_TESTS.length; i++ ) {
			matched = false;
			for ( j = 0; j < skipped.length; j++ ) {
				if ( skipped[ j ].module === EXCLUDED_TESTS[ i ].module &&
						skipped[ j ].name === EXCLUDED_TESTS[ i ].name ) {
					matched = true;
				}
			}
			if ( !matched ) {
				staleExclusions.push( testLabel( EXCLUDED_TESTS[ i ].module, EXCLUDED_TESTS[ i ].name ) );
			}
		}

		for ( i = 0; i < list.length; i++ ) {
			assertionsPassed += list[ i ].passed;
			assertionsFailed += list[ i ].failed;
			if ( list[ i ].failed > 0 ) {
				testsFailed++;
				failedTests.push( testLabel( list[ i ].module, list[ i ].name ) );
			} else {
				testsPassed++;
			}
		}

		print( "" );
		if ( failedTests.length ) {
			print( "Failed tests:" );
			for ( i = 0; i < failedTests.length; i++ ) {
				print( "  FAIL " + failedTests[ i ] );
			}
			print( "" );
		}
		if ( doneDetails ) {
			print( "QUnit reported: " + doneDetails.passed + " passed, " + doneDetails.failed +
				" failed, " + doneDetails.total + " total assertions in " +
				doneDetails.runtime + " ms" );
		}
		if ( skipped.length ) {
			print( "Skipped tests (EXCLUDED_TESTS):" );
			for ( i = 0; i < skipped.length; i++ ) {
				print( "  SKIP " + testLabel( skipped[ i ].module, skipped[ i ].name ) +
					" -- " + skipped[ i ].reason );
			}
			print( "" );
		}
		if ( staleExclusions.length ) {
			print( "Stale EXCLUDED_TESTS entries (matched no registered test):" );
			for ( i = 0; i < staleExclusions.length; i++ ) {
				print( "  STALE " + staleExclusions[ i ] );
			}
			print( "" );
		}
		print( "Tests: " + testsPassed + " passed, " + testsFailed + " failed, " +
			skipped.length + " skipped, " + ( list.length + skipped.length ) +
			" total; assertions: " + assertionsPassed + " passed, " +
			assertionsFailed + " failed" );
		print( "Elapsed: " + Math.round( ( new Date().getTime() - startedAt ) / 1000 ) + " s" );

		if ( reason ) {
			print( "RESULT: FAILED (" + reason + ")" );
			return 1;
		}
		if ( staleExclusions.length ) {
			print( "RESULT: FAILED (" + staleExclusions.length +
				" EXCLUDED_TESTS entries matched no registered test)" );
			return 1;
		}
		if ( list.length === 0 ) {
			print( "RESULT: FAILED (no tests were run)" );
			return 1;
		}
		if ( testsFailed > 0 || ( doneDetails && doneDetails.failed > 0 ) ) {
			print( "RESULT: FAILED" );
			return 1;
		}
		print( "RESULT: PASSED" );
		return 0;
	}

	// Fallback: read results from the QUnit DOM report when the callback
	// hooks could not be installed.
	function readDomResults() {
		return page.evaluate( function() {
			var i, j, li, moduleEl, nameEl, failedEl, passedEl, items, msgEl,
				out = [],
				container = document.getElementById( "qunit-tests" ),
				nodes = container ? container.children : [];

			for ( i = 0; i < nodes.length; i++ ) {
				li = nodes[ i ];
				if ( li.tagName !== "LI" ) {
					continue;
				}
				moduleEl = li.querySelector( ".module-name" );
				nameEl = li.querySelector( ".test-name" );
				failedEl = li.querySelector( ".counts .failed" );
				passedEl = li.querySelector( ".counts .passed" );
				items = li.querySelectorAll( "ol > li.fail" );
				out.push({
					module: moduleEl ? moduleEl.textContent : "",
					name: nameEl ? nameEl.textContent : li.id,
					failed: failedEl ? parseInt( failedEl.textContent, 10 ) || 0 :
						( /\bfail\b/.test( li.className ) ? 1 : 0 ),
					passed: passedEl ? parseInt( passedEl.textContent, 10 ) || 0 : 0,
					failures: []
				});
				for ( j = 0; j < items.length; j++ ) {
					msgEl = items[ j ].querySelector( ".test-message" );
					out[ out.length - 1 ].failures.push({
						message: msgEl ? msgEl.textContent : items[ j ].textContent
					});
				}
				out[ out.length - 1 ].total = out[ out.length - 1 ].failed +
					out[ out.length - 1 ].passed;
			}
			return out;
		});
	}

	function finishFromDom() {
		var i, list;

		print( "WARNING: QUnit callbacks did not report results; reading the DOM report" );
		list = readDomResults() || [];
		for ( i = 0; i < list.length; i++ ) {
			printTest( list[ i ] );
		}
		exit( summarize( list ) );
	}

	function finish() {
		exit( summarize( results ) );
	}

	// Messages sent from the page via window.callPhantom
	function onMessage( msg ) {
		if ( !msg || finished ) {
			return;
		}

		switch ( msg.type ) {
		case "hooked":
			hooked = true;
			print( "QUnit " + ( msg.version ? msg.version + " " : "" ) + "callbacks installed" );
			break;

		case "begin":
			print( "QUnit run started" );
			break;

		case "moduleStart":
			print( "# Module: " + ( msg.name || "(no module)" ) );
			break;

		case "testStart":
			// QUnit 1.x may report "done" more than once if tests are queued late
			if ( doneTimer ) {
				window.clearTimeout( doneTimer );
				doneTimer = null;
			}
			currentTest = { module: msg.module, name: msg.name };
			currentFailures = [];
			break;

		case "assertionFailed":
			currentFailures.push( msg );
			break;

		case "skip":
			skipped.push({ module: msg.module, name: msg.name, reason: msg.reason });
			print( "SKIP " + testLabel( msg.module, msg.name ) + " -- " + msg.reason );
			break;

		case "testDone":
			results.push({
				module: msg.module,
				name: msg.name,
				failed: msg.failed,
				passed: msg.passed,
				total: msg.total,
				runtime: msg.runtime,
				failures: currentFailures
			});
			printTest( results[ results.length - 1 ] );
			currentTest = null;
			currentFailures = [];
			break;

		case "done":
			doneDetails = msg;
			if ( doneTimer ) {
				window.clearTimeout( doneTimer );
			}
			doneTimer = window.setTimeout( finish, 1000 );
			break;

		case "debug":
			print( "RUNNER: " + msg.message );
			break;
		}
	}

	// Injected into the page before any page script runs: registers the QUnit
	// logging callbacks the moment qunit.js assigns window.QUnit, so no test is
	// missed (testinit.js disables autostart; tests start well after that).
	function installHooks( excludedTests ) {
		/* jshint browser: true */
		if ( window.__phantomRunnerInstalled ) {
			return;
		}
		window.__phantomRunnerInstalled = true;

		var qunitValue, pollId,
			nativeAddEventListener = window.addEventListener,
			excluded = excludedTests || [];

		function send( msg ) {
			if ( typeof window.callPhantom === "function" ) {
				window.callPhantom( msg );
			}
		}

		function dump( value ) {
			try {
				var text = window.QUnit && window.QUnit.jsDump ?
					window.QUnit.jsDump.parse( value ) : String( value );
				text = String( text );
				return text.length > 400 ? text.slice( 0, 400 ) + "..." : text;
			} catch ( e ) {
				return "[unserializable: " + e + "]";
			}
		}

		function exclusionFor( module, name ) {
			var i;
			for ( i = 0; i < excluded.length; i++ ) {
				if ( excluded[ i ].module === module && excluded[ i ].name === name ) {
					return excluded[ i ];
				}
			}
			return null;
		}

		// Drop EXCLUDED_TESTS at registration time so they never execute.
		// QUnit 1.14: the unit files call the global test() (copied onto
		// window from QUnit's prototype), and asyncTest() delegates to
		// QUnit.test(), so wrapping those two covers test, asyncTest,
		// ajaxTest, testIframe and testIframeWithCallback without counting
		// any registration twice.
		function wrapRegistration( owner, Q ) {
			var register = owner.test;
			if ( typeof register !== "function" || register.__phantomRunnerWrapped ) {
				return;
			}
			owner.test = function( testName ) {
				var module = Q.config.currentModule,
					exclusion = exclusionFor( module, testName );
				if ( exclusion ) {
					send({ type: "skip", module: module, name: testName, reason: exclusion.reason });
					return;
				}
				return register.apply( this, arguments );
			};
			owner.test.__phantomRunnerWrapped = true;
		}

		function hook( Q ) {
			if ( !Q || Q.__phantomRunnerHooked || typeof Q.testDone !== "function" ) {
				return;
			}
			Q.__phantomRunnerHooked = true;

			wrapRegistration( window, Q );
			wrapRegistration( Q, Q );

			Q.begin(function() {
				window.__phantomRunnerBegun = true;
				send({ type: "begin" });
			});
			Q.moduleStart(function( details ) {
				send({ type: "moduleStart", name: details.name });
			});
			Q.testStart(function( details ) {
				send({ type: "testStart", module: details.module, name: details.name });
			});
			Q.log(function( details ) {
				if ( details.result ) {
					return;
				}
				var hasExpected = details.hasOwnProperty( "expected" );
				send({
					type: "assertionFailed",
					module: details.module,
					name: details.name,
					message: details.message ? String( details.message ) : "",
					hasExpected: hasExpected,
					expected: hasExpected ? dump( details.expected ) : "",
					actual: hasExpected ? dump( details.actual ) : "",
					source: details.source ? String( details.source ) : ""
				});
			});
			Q.testDone(function( details ) {
				send({
					type: "testDone",
					module: details.module,
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				});
			});
			Q.done(function( details ) {
				send({
					type: "done",
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				});
			});
			send({ type: "hooked", version: Q.version || "" });
		}

		// PhantomJS 2.1.1 segfaults (QtWebKit) on an XMLHttpRequest whose
		// method carries a body (POST/PATCH/...) but is sent without one;
		// the ajax module does that in several tests. Send an empty string
		// instead, which is the same empty request body on the wire.
		( function( proto ) {
			var nativeOpen = proto.open,
				nativeSend = proto.send;

			proto.open = function( method ) {
				this.__phantomRunnerMethod = String( method ).toUpperCase();
				return nativeOpen.apply( this, arguments );
			};
			proto.send = function( body ) {
				if ( ( body === undefined || body === null ) && this.__phantomRunnerMethod &&
						this.__phantomRunnerMethod !== "GET" && this.__phantomRunnerMethod !== "HEAD" ) {
					return nativeSend.call( this, "" );
				}
				return nativeSend.apply( this, arguments );
			};
		}( window.XMLHttpRequest.prototype ) );

		// Late install (qunit.js already loaded): hook directly
		if ( window.QUnit ) {
			hook( window.QUnit );
			return;
		}

		// QUnit 1.14 registers QUnit.load as a window "load" listener, and
		// testinit.js also calls QUnit.load() once the async test modules are
		// loaded. In a real browser the window load event wins that race; in
		// PhantomJS it can fire after the suite has started (an iframe created
		// by a test delays it), and the second QUnit.load() wipes the
		// #qunit-tests report mid-run (TypeError in QUnit's Test.finish, run
		// hangs). Make that window-load call a no-op once QUnit.load() already
		// ran. Only QUnit's own listener is wrapped; the native method is
		// restored as soon as qunit.js assigns window.QUnit.
		window.addEventListener = function( type, fn, capture ) {
			var qunitLoad = fn;
			if ( type === "load" && typeof fn === "function" &&
					String( fn ).indexOf( "runLoggingCallbacks( \"begin\"" ) !== -1 ) {
				fn = function() {
					if ( window.__phantomRunnerBegun ) {
						send({ type: "debug", message: "window load fired after QUnit.load(); " +
							"skipped the duplicate QUnit.load() call" });
						return;
					}
					return qunitLoad.apply( this, arguments );
				};
			}
			return nativeAddEventListener.call( this, type, fn, capture );
		};

		function restoreAddEventListener() {
			if ( window.addEventListener !== nativeAddEventListener ) {
				try {
					delete window.addEventListener;
				} catch ( e ) {}
				if ( window.addEventListener !== nativeAddEventListener ) {
					window.addEventListener = nativeAddEventListener;
				}
			}
		}

		// Primary: trap the window.QUnit assignment made at the end of qunit.js
		try {
			Object.defineProperty( window, "QUnit", {
				configurable: true,
				enumerable: true,
				get: function() {
					return qunitValue;
				},
				set: function( value ) {
					qunitValue = value;
					restoreAddEventListener();
					hook( value );
				}
			});
		} catch ( e ) {
			send({ type: "debug", message: "could not trap window.QUnit: " + e });
		}

		// Secondary: poll in case the property trap did not fire
		pollId = window.setInterval(function() {
			if ( window.QUnit ) {
				restoreAddEventListener();
				hook( window.QUnit );
				if ( window.QUnit.__phantomRunnerHooked ) {
					window.clearInterval( pollId );
				}
			}
		}, 1 );
	}

	function poll() {
		var state;

		if ( finished ) {
			return;
		}

		state = page.evaluate( function() {
			var el = document.getElementById( "qunit-testresult" );
			return {
				completed: !!( el && /Tests completed/.test( el.textContent || "" ) ),
				hooked: !!( window.QUnit && window.QUnit.__phantomRunnerHooked )
			};
		});

		if ( state && state.completed ) {
			if ( !domCompletedAt ) {
				domCompletedAt = new Date().getTime();
			}

			// The QUnit report says the run is complete but no "done" callback
			// arrived: fall back to the DOM (or to what the callbacks recorded).
			if ( !doneDetails && new Date().getTime() - domCompletedAt > 10000 ) {
				if ( results.length === 0 ) {
					finishFromDom();
				} else {
					print( "WARNING: QUnit report complete but no done callback received" );
					finish();
				}
				return;
			}
		}

		window.setTimeout( poll, 500 );
	}

	if ( !url ) {
		print( "Usage: phantomjs test/phantomjs-qunit-runner.js <url> [timeout-seconds]" );
		phantom.exit( 2 );
		return;
	}

	phantom.onError = function( msg, trace ) {
		print( "PHANTOM ERROR: " + msg );
		( trace || [] ).forEach(function( t ) {
			print( "    at " + ( t.file || t.sourceURL ) + ":" + t.line +
				( t["function"] ? " (" + t["function"] + ")" : "" ) );
		});
		exit( 1 );
	};

	page = webpage.create();
	page.viewportSize = { width: 1280, height: 1024 };

	page.onInitialized = function() {
		page.evaluate( installHooks, EXCLUDED_TESTS );
	};

	page.onCallback = onMessage;

	page.onConsoleMessage = function( msg, line, source ) {
		print( "CONSOLE: " + msg + ( source ? " (" + source + ":" + line + ")" : "" ) );
	};

	page.onAlert = function( msg ) {
		print( "ALERT: " + msg );
	};

	page.onError = function( msg, trace ) {
		// Uncaught page errors; QUnit's window.onerror also records them as
		// failures when they happen inside (or outside) a test.
		print( "PAGE ERROR: " + msg +
			( currentTest ? " [during " + testLabel( currentTest.module, currentTest.name ) + "]" : "" ) );
		( trace || [] ).forEach(function( t ) {
			print( "    at " + t.file + ":" + t.line + ( t["function"] ? " (" + t["function"] + ")" : "" ) );
		});
	};

	page.onResourceError = function( error ) {
		// Ajax tests abort requests on purpose (code 5 = operation canceled)
		if ( error && error.errorCode !== 5 ) {
			print( "RESOURCE ERROR: " + error.url + " (" + error.errorCode + ": " +
				error.errorString + ")" );
		}
	};

	window.setTimeout( function() {
		if ( finished ) {
			return;
		}
		print( "" );
		print( "TIMEOUT: QUnit did not finish within " + timeoutSeconds + " s" +
			( currentTest ? "; still running " + testLabel( currentTest.module, currentTest.name ) : "" ) );
		exit( summarize( results, "global timeout of " + timeoutSeconds + " s exceeded" ) );
	}, timeoutSeconds * 1000 );

	print( "Opening " + url + " (timeout " + timeoutSeconds + " s)" );

	page.open( url, function( status ) {
		if ( opened ) {
			return;
		}
		opened = true;

		if ( status !== "success" ) {
			print( "ERROR: unable to load " + url + " (status: " + status + ")" );
			exit( 1 );
			return;
		}

		if ( !hooked ) {
			// Covers the case where onInitialized fired before callPhantom was usable
			page.evaluate( installHooks, EXCLUDED_TESTS );
		}
		poll();
	});
}() );
