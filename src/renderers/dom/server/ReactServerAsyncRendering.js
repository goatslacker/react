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
var isReadableStream = require('isReadableStream');

var rollingAdler32 = require("rollingAdler32");
var stream = require("stream");

// this is a pass through stream that can calculate the hash that is used to 
// checksum react server-rendered elements.
class Adler32Stream extends stream.Transform {
  constructor(rootId, options) {
    super(options);
    this.rootId = rootId;
    this.rollingHash = rollingAdler32("");
    this.on("end", () => { this.done = true; })
  }

  _transform(chunk, encoding, next) {
    this.rollingHash = rollingAdler32(chunk.toString("utf-8"), this.rollingHash);
    this.push(chunk);
    next();
  }

  _flush(next) {
    let hash = this.rollingHash.hash();
    let scriptId = `${this.rootId}.script`;
    this.push(
      `<script type="text/javascript" id="${scriptId}">
        if (!document.querySelector) throw new Error("react-dom-stream requires document.querySelector. If using IE8 or IE9, please make sure you are in standards mode by including <!DOCTYPE html>");
        document.querySelector('[data-reactid="${this.rootId}"]').setAttribute("data-react-checksum", ${hash});
        var s = document.getElementById("${scriptId}");
        s.parentElement.removeChild(s);
      </script>`
    );
    next();
  }
}

class RenderStream extends stream.Readable {
  constructor(componentInstance, id, transaction, context, cache, options, maxStackDepth) {
    super(options);
    this.buffer = "";
    this.componentInstance = componentInstance;
    this.id = id;
    this.transaction = transaction;
    this.context = context;
    this.cache = cache;
    this.maxStackDepth = maxStackDepth || 500;
    this.nextTickCalls = 0;
  }

  _read(n) {
    var bufferToPush;
    if (this.done) {
      this.push(null);
      return;
    }
    // it's possible that the last chunk added bumped the buffer up to > 2 * n, which means we will
    // need to go through multiple read calls to drain it down to < n.
    if (this.buffer.length >= n) {
      bufferToPush = this.buffer.substring(0, n);
      this.buffer = this.buffer.substring(n);
      this.push(bufferToPush);
      return;
    }

    if (this.stream) {
       let data = this.stream.read(n);
      // if the underlying stream isn't ready, it returns null, so we push a blank string to
      // get it to work.
      if (null === data) {
        this.push("");
      } else {
        this.push(data);
      }
      return;
    }
    // if we have are already rendering and have a continuation to call, do so.
    if (this.continuation) {
      // continue with the rendering.
      this.continuation();
      return;
    }

    this.stackDepth = 0;
    // start the rendering chain.
    this.componentInstance.mountComponentAsync(this.id, this.transaction, this.context, 
      (text, cb) => {
        if (isReadableStream(text)) {
          // this is a stream
          this.stream = text;
          this.stream.on("end", () => {
            this.stream = null;
            cb();
          });
          let data = this.stream.read(n - this.buffer.length);

          setImmediate(() => {
            if (data === null) data = this.stream.read(n - this.buffer.length);
            this.push(this.buffer + (data === null ? "" : data));
            this.buffer = "";
          });          
          return;
        }

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
      this.cache,
      () => {
        // the rendering is finished; we should push out the last of the buffer.
        this.done = true;
        this.push(this.buffer);
      })

  }
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup
 */
function renderToStringStream(element, {syncBatching = false, cache, rootID} = {}) {
  invariant(
    ReactElement.isValidElement(element),
    'renderToStringStream(): You must pass a valid ReactElement.'
  );

  var transaction;

  // NOTE that we never change this, which means that client rendering code cannot be used
  // in conjunction with this code.
  ReactUpdates.injection.injectBatchingStrategy(ReactServerBatchingStrategy);

  var id = rootID || ReactInstanceHandles.createReactRootID();
  transaction = ReactServerRenderingTransaction.getPooled(false);

  var readable = transaction.perform(function() {
    var componentInstance = instantiateReactComponent(element, null);
    return new RenderStream(componentInstance, id, transaction, emptyObject, cache);
  }, null);

  readable.on("end", () => {
    ReactServerRenderingTransaction.release(transaction);
    // Revert to the DOM batching strategy since these two renderers
    // currently share these stateful modules.
    // NOTE: THIS SHOULD ONLY BE DONE IN TESTS OR OTHER ENVIRONMENTS KNOWN TO BE SYNCHRONOUS.
    if (syncBatching) ReactUpdates.injection.injectBatchingStrategy(ReactDefaultBatchingStrategy);
  });

  return readable.pipe(new Adler32Stream(id));
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup, without the extra React ID and checksum
 * (for generating static pages)
 */
function renderToStaticMarkupStream(element, {cache, rootID} = {}) {
  invariant(
    ReactElement.isValidElement(element),
    'renderToStaticMarkupStream(): You must pass a valid ReactElement.'
  );

  var transaction;

  // NOTE that we never change this, which means that client rendering code cannot be used
  // in conjunction with this code.
  ReactUpdates.injection.injectBatchingStrategy(ReactServerBatchingStrategy);

  var id = rootID || ReactInstanceHandles.createReactRootID();
  transaction = ReactServerRenderingTransaction.getPooled(true);

  var readable = transaction.perform(function() {
    var componentInstance = instantiateReactComponent(element, null);
    return new RenderStream(componentInstance, id, transaction, emptyObject, cache);
  }, null);

  readable.on("end", () => {
    ReactServerRenderingTransaction.release(transaction);
  });

  return readable;
}

module.exports = {
  renderToStringStream: renderToStringStream,
  renderToStaticMarkupStream: renderToStaticMarkupStream,
};
