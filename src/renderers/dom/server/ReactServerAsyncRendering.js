/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @typechecks static-only
 * @providesModule ReactServerAsyncRendering
 */
'use strict';

var ReactDefaultBatchingStrategy = require('ReactDefaultBatchingStrategy');
var ReactElement = require('ReactElement');
var ReactInstanceHandles = require('ReactInstanceHandles');
var ReactMarkupChecksum = require('ReactMarkupChecksum');
var ReactServerBatchingStrategy = require('ReactServerBatchingStrategy');
var ReactServerRenderingTransaction =
  require('ReactServerRenderingTransaction');
var ReactUpdates = require('ReactUpdates');

var emptyObject = require('emptyObject');
var instantiateReactComponent = require('instantiateReactComponent');
var invariant = require('invariant');

var rollingAdler32 = require("rollingAdler32");
var stream = require("stream");

// this is a pass through stream that can calculate the hash that is used to 
// checksum react server-rendered elements.
class Adler32Stream extends stream.Transform {
  constructor(options) {
    super(options);
    this.rollingHash = rollingAdler32("");
    this.on("end", () => { this.done = true; })
  }

  _transform(chunk, encoding, next) {
    this.rollingHash = rollingAdler32(chunk.toString("utf-8"), this.rollingHash);
    this.push(chunk);
    next();
  }

  // returns a promise of a hash that resolves when this readable piped into this is finished.
  get hash() {
    if (this.done) {
      return Promise.resolve(this.rollingHash.hash());
    }
    return new Promise((resolve, reject) => {
      this.on("end", () => {
        resolve(this.rollingHash.hash());
      });
    });
  }
}

class RenderStream extends stream.Readable {
  constructor(componentInstance, id, transaction, context, options, maxStackDepth) {
    super(options);
    this.buffer = "";
    this.componentInstance = componentInstance;
    this.id = id;
    this.transaction = transaction;
    this.context = context;
    this.maxStackDepth = maxStackDepth || 500;
    this.nextTickCalls = 0;
  }

  _read(n) {
    var bufferToPush;
    // it's possible that the last chunk added bumped the buffer up to > 2 * n, which means we will
    // need to go through multiple read calls to drain it down to < n.
    if (this.done) {
      this.push(null);
      return;
    }
    if (this.buffer.length >= n) {
      bufferToPush = this.buffer.substring(0, n);
      this.buffer = this.buffer.substring(n);
      this.push(bufferToPush);
      return;
    }
    if (!this.continuation) {
      this.stackDepth = 0;
      // start the rendering chain.
      this.componentInstance.mountComponentAsync(this.id, this.transaction, this.context, 
        (text, cb) => {
          this.buffer += text;
          if (this.buffer.length >= n) {
            this.continuation = cb;
            bufferToPush = this.buffer.substring(0, n);
            this.buffer = this.buffer.substring(n);
            this.push(bufferToPush);
          } else {
            // continue rendering until we have enough text to call this.push().
            // sometimes do this as process.nextTick to get out of stack overflows.
            if (this.stackDepth >= this.maxStackDepth) {
              process.nextTick(cb);
            } else {
              this.stackDepth++;
              cb();
              this.stackDepth--;
            }
          }
        },
        () => {
          // the rendering is finished; we should push out the last of the buffer.
          this.done = true;
          this.push(this.buffer);
        })

    } else {
      // continue with the rendering.
      this.continuation();
    }
  }
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup
 */
function renderToStringStream(element, res, {syncBatching = false} = {}) {
  invariant(
    ReactElement.isValidElement(element),
    'renderToStringStream(): You must pass a valid ReactElement.'
  );

  var transaction;

  // NOTE that we never change this, which means that client rendering code cannot be used
  // in conjunction with this code.
  ReactUpdates.injection.injectBatchingStrategy(ReactServerBatchingStrategy);

  var id = ReactInstanceHandles.createReactRootID();
  transaction = ReactServerRenderingTransaction.getPooled(false);

  if (res) {
    return new Promise((resolve, reject) => {
      console.warn("You are using version 0.1.x of the API, which has been deprecated. Please update your client code to use the 0.2.x API, which is based on streams.");
      var hash = rollingAdler32("");
      var readable = transaction.perform(function() {
        var buffer = "";
        var componentInstance = instantiateReactComponent(element, null);
        componentInstance.mountComponentAsync(id, transaction, emptyObject, 
          (text, cb) => {
            hash = rollingAdler32(text, hash);
            buffer += text;
            if (buffer.length >= 16 * 1024) {
              res.write(buffer);
              buffer = "";
              process.nextTick(cb);
            } else {
              cb();
            }
          },
          () => {
            res.write(buffer);
            ReactServerRenderingTransaction.release(transaction);
            resolve(hash.hash());
          });
        return null;
      }, null);
    });
  } else {
    var readable = transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      return new RenderStream(componentInstance, id, transaction, emptyObject);
    }, null);

    readable.on("end", () => {
      ReactServerRenderingTransaction.release(transaction);
      // Revert to the DOM batching strategy since these two renderers
      // currently share these stateful modules.
      // NOTE: THIS SHOULD ONLY BE DONE IN TESTS OR OTHER ENVIRONMENTS KNOWN TO BE SYNCHRONOUS.
      if (syncBatching) ReactUpdates.injection.injectBatchingStrategy(ReactDefaultBatchingStrategy);
    });

    // since Adler32Stream has a .hash property, this automagically adds that property to the result.
    return readable.pipe(new Adler32Stream());
  }
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup, without the extra React ID and checksum
 * (for generating static pages)
 */
function renderToStaticMarkupStream(element, res) {
  invariant(
    ReactElement.isValidElement(element),
    'renderToStaticMarkupStream(): You must pass a valid ReactElement.'
  );

  var transaction;

  // NOTE that we never change this, which means that client rendering code cannot be used
  // in conjunction with this code.
  ReactUpdates.injection.injectBatchingStrategy(ReactServerBatchingStrategy);

  var id = ReactInstanceHandles.createReactRootID();
  transaction = ReactServerRenderingTransaction.getPooled(true);

  if (res) {
    return new Promise((resolve, reject) => {
      console.warn("You are using version 0.1.x of the API, which has been deprecated. Please update your client code to use the 0.2.x API, which is based on streams.");
      let readable = transaction.perform(function() {
        let buffer = "";
        const componentInstance = instantiateReactComponent(element, null);
        componentInstance.mountComponentAsync(id, transaction, emptyObject, 
          (text, cb) => {
            buffer += text;
            if (buffer.length >= 16 * 1024) {
              res.write(buffer);
              buffer = "";
              process.nextTick(cb);
            } else {
              cb();
            }
          },
          () => {
            res.write(buffer);
            ReactServerRenderingTransaction.release(transaction);
            resolve();
          });
        return null;
      }, null);
    });
  } else {
    var readable = transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      return new RenderStream(componentInstance, id, transaction, emptyObject);
    }, null);

    readable.on("end", () => {
      ReactServerRenderingTransaction.release(transaction);
    });

    return readable;
  }
}

module.exports = {
  renderToStringStream: renderToStringStream,
  renderToStaticMarkupStream: renderToStaticMarkupStream,
};
