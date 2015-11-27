/**
 * Copyright 2015, Sasha Aickin
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isReadableStream
 * @typechecks static-only
 */

// ducktype checking for a Readable stream

export default function isReadableStream(input) {

  return (
    typeof input.isPaused === "function" && 
    typeof input.pause === "function" && 
    typeof input.pipe === "function" && 
    typeof input.read === "function" && 
    typeof input.resume === "function" && 
    typeof input.setEncoding === "function" && 
    typeof input.unpipe === "function" && 
    typeof input.unshift === "function" && 
    typeof input.wrap === "function"
    );
}
