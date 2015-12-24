/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @emails react-core
 */

'use strict';

var mocks = require('mocks');
var stream = require('stream');

var ExecutionEnvironment;
var React;
var ReactDOM;
var ReactMarkupChecksum;
var ReactReconcileTransaction;
var ReactTestUtils;
var ReactServerAsyncRendering;

var concatStream;

var ID_ATTRIBUTE_NAME;

// a simple helper that makes a Writable string stream which calls callback with its entire buffer when
// end() is called.
var output = (callback) => {
  return concatStream({encoding: "string"}, callback);
}

var expectRenderToStringStream = (component, regex) => {
  render(component, ReactServerAsyncRendering.renderToStringStream, (result, done) => {
    expect(result).toMatch(regex);
    done();
  });
};

var expectRenderToStaticMarkupStream = (component, exactMatch) => {
  render(component, ReactServerAsyncRendering.renderToStaticMarkupStream, 
    (result, done) => {
      expect(result).toEqual(exactMatch);
      done();
    }
  );
};

var render = (component, renderer, callback) => {
  var done = false;
  renderer(component).pipe(output((result) => {
    callback(result, () => {
      done = true;
    });
  }));

  waitsFor(() => { return done; });
}

var stringToStream = (input) => {
  var s = new stream.Readable();
  var pushed = false;
  s._read = function(n) {
    if (pushed) {
      this.push(null);
    } else {
      pushed = true;
      this.push(input);
    }
  }; 
  return s;
}

let beforeEachFn = () => {
    require('mock-modules').dumpCache();
    React = require('React');
    ReactDOM = require('ReactDOM');
    ReactMarkupChecksum = require('ReactMarkupChecksum');
    ReactTestUtils = require('ReactTestUtils');
    ReactReconcileTransaction = require('ReactReconcileTransaction');

    ExecutionEnvironment = require('ExecutionEnvironment');
    ExecutionEnvironment.canUseDOM = false;
    ReactServerAsyncRendering = require('ReactServerAsyncRendering');

    concatStream = require('concat-stream');

    var DOMProperty = require('DOMProperty');
    ID_ATTRIBUTE_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
    spyOn(console, 'error');
}

describe('ReactServerAsyncRendering', function() {
  beforeEach(beforeEachFn);

  describe('renderToStringStream', function() {
    it('should generate simple markup', function() {
      expectRenderToStringStream(
        <span>hello world</span>, 
        '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">hello world</span>');
    });

    it('should generate simple markup for self-closing tags', function() {
      expectRenderToStringStream(
        <img />, 
        '<img ' + ID_ATTRIBUTE_NAME + '="[^"]+"/>');
    });

    it('should generate empty markup for non self-closing tags', function() {
      expectRenderToStringStream(
        <span></span>, 
        '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+"></span>');
    });

    it('should generate simple markup for attribute with `>` symbol', function() {
      expectRenderToStringStream(
        <img data-attr=">" />, 
        '<img data-attr="&gt;" ' + ID_ATTRIBUTE_NAME + '="[^"]+"/>');
    });

    it('should generate markup for pure functional components without props', function() {
      var HelloWorld = () => {
        return <span>hello world</span>
      };

      expectRenderToStringStream(
        <HelloWorld/>, 
        '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">hello world</span>');
    });

    it('should not stack overflow with large arrays of children', function() {
      var done = false;

      var StackOverflow = () => {
        let children = [];
        for (let i = 0; i < 100000; i++) {
          children.push(<div key={i}>abcdefghij</div>);
        }
        return <div>{children}</div>
      };

      ReactServerAsyncRendering.renderToStringStream(<StackOverflow/>).pipe(output((result)=> {
        done = true;
      }));

      waitsFor(function() {return done;});
    });

    it('should generate markup for pure functional components with props & text sections', function() {
      var HelloWorld = ({name}) => {
        return <span>hello {name}</span>
      };

      expectRenderToStringStream(
        <HelloWorld name="React"/>, 
        '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">hello </span>' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">React</span>' +
        '</span>');
    });

    it('should add a newline for newline-eating tags', function() {
      expectRenderToStringStream(
        <pre>{"\nContents"}</pre>, 
        '<pre ' + ID_ATTRIBUTE_NAME + '="[^"]+">\n\nContents</pre>');
      expectRenderToStringStream(
        <pre>{"\nConte\nts"}</pre>, 
        '<pre ' + ID_ATTRIBUTE_NAME + '="[^"]+">\n\nConte\nts</pre>');
    });
    
    it('should not add a newline for non-newline-eating tags', function() {
      expectRenderToStringStream(
        <div>{"\nContents"}</div>, 
        '<div ' + ID_ATTRIBUTE_NAME + '="[^"]+">\nContents</div>');
      expectRenderToStringStream(
        <div>{"\nConte\nts"}</div>, 
        '<div ' + ID_ATTRIBUTE_NAME + '="[^"]+">\nConte\nts</div>');
    });
    
    it('should generate markup for arrays of components', function() {
      var Number = ({num}) => {
        return <span>{num.toString()}</span>;
      };
      var Counter = () => {
        return <div>{[<Number num={1}/>,<Number num={2}/>,<Number num={3}/>]}</div>
      };

      expectRenderToStringStream(
        <Counter/>, 
        '<div ' + ID_ATTRIBUTE_NAME + '="[^"]+">' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">1</span>' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">2</span>' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">3</span>' +
        '</div>');
    });

    it('should not register event listeners', function() {
      var EventPluginHub = require('EventPluginHub');
      var cb = mocks.getMockFunction();

      render(
        <span onClick={cb}>hello world</span>,
        ReactServerAsyncRendering.renderToStringStream,
        (result, done) => {
          expect(EventPluginHub.__getListenerBank()).toEqual({});
          done();
        }
      )
    });

    it('should render composite components', function() {
      var Parent = React.createClass({
        render: function() {
          return <div><Child name="child" /></div>;
        },
      });
      var Child = React.createClass({
        render: function() {
          return <span>My name is {this.props.name}</span>;
        },
      });

      expectRenderToStringStream(
        <Parent />,
        '<div ' + ID_ATTRIBUTE_NAME + '="[^"]+">' +
          '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">' +
            '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">My name is </span>' +
            '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">child</span>' +
          '</span>' +
        '</div>'
      );
    });

    it('should only execute certain lifecycle methods v 0.2.x', function() {
      var runCount = 0;
      function runTest() {
        var lifecycle = [];
        var TestComponent = React.createClass({
          componentWillMount: function() {
            lifecycle.push('componentWillMount');
          },
          componentDidMount: function() {
            lifecycle.push('componentDidMount');
          },
          getInitialState: function() {
            lifecycle.push('getInitialState');
            return {name: 'TestComponent'};
          },
          render: function() {
            lifecycle.push('render');
            return <span>Component name: {this.state.name}</span>;
          },
          componentWillUpdate: function() {
            lifecycle.push('componentWillUpdate');
          },
          componentDidUpdate: function() {
            lifecycle.push('componentDidUpdate');
          },
          shouldComponentUpdate: function() {
            lifecycle.push('shouldComponentUpdate');
          },
          componentWillReceiveProps: function() {
            lifecycle.push('componentWillReceiveProps');
          },
          componentWillUnmount: function() {
            lifecycle.push('componentWillUnmount');
          },
        });

        var expectFn = (result) => {
          expect(result).toMatch(
            '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">' +
              '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">Component name: </span>' +
              '<span ' + ID_ATTRIBUTE_NAME + '="[^"]+">TestComponent</span>' +
            '</span>'
          );

          expect(lifecycle).toEqual(
            ['getInitialState', 'componentWillMount', 'render']
          );

          runCount++;
        };

        ReactServerAsyncRendering.renderToStringStream(
          <TestComponent />
        ).pipe(output(expectFn));
      }

      runTest();

      // This should work the same regardless of whether you can use DOM or not.
      ExecutionEnvironment.canUseDOM = true;
      runTest();

      waitsFor(function() {return (runCount == 2);});

    });

    it('should have the correct mounting behavior', function() {
      var done = false;
      // This test is testing client-side behavior.
      ExecutionEnvironment.canUseDOM = true;

      var mountCount = 0;
      var numClicks = 0;

      var TestComponent = React.createClass({
        componentDidMount: function() {
          mountCount++;
        },
        click: function() {
          numClicks++;
        },
        render: function() {
          return (
            <span ref="span" onClick={this.click}>Name: {this.props.name}</span>
          );
        },
      });

      var element = document.createElement('div');
      document.body.appendChild(element);
      ReactDOM.render(<TestComponent />, element);

      var lastMarkup = element.innerHTML;

      // Exercise the update path. Markup should not change,
      // but some lifecycle methods should be run again.
      ReactDOM.render(<TestComponent name="x" />, element);
      expect(mountCount).toEqual(1);

      // Unmount and remount. We should get another mount event and
      // we should get different markup, as the IDs are unique each time.
      ReactDOM.unmountComponentAtNode(element);
      expect(element.innerHTML).toEqual('');
      ReactDOM.render(<TestComponent name="x" />, element);
      expect(mountCount).toEqual(2);
      expect(element.innerHTML).not.toEqual(lastMarkup);

      // Now kill the node and render it on top of server-rendered markup, as if
      // we used server rendering. We should mount again, but the markup should
      // be unchanged. We will append a sentinel at the end of innerHTML to be
      // sure that innerHTML was not changed.
      ReactDOM.unmountComponentAtNode(element);
      expect(element.innerHTML).toEqual('');

      ExecutionEnvironment.canUseDOM = false;

      var renderStream = ReactServerAsyncRendering.renderToStringStream(
        <TestComponent name="x" />, null, {syncBatching: true}
      );
      renderStream.pipe(output((lastMarkup) => {
        ExecutionEnvironment.canUseDOM = true;
        // scripts don't run get added you add them to the DOM using innerHTML, so we have to 
        // parse it out and eval it.
        element.innerHTML = lastMarkup.replace(/<script([^]*)<\/script>/, "<span$1</span>");
        eval(element.children[1].innerHTML);

        ReactDOM.render(<TestComponent name="x" />, element);
        expect(mountCount).toEqual(3);
        expect(element.innerHTML).toMatch(
          // remove the script tag and add the react checksum to create a matcher.
          lastMarkup.replace(/<script[^>]*>([^]*)<\/script>/, "").replace(/^<span([^>]*)/, '<span$1 data-react-checksum=".*"')
        );
        ReactDOM.unmountComponentAtNode(element);
        expect(element.innerHTML).toEqual('');

        // Now simulate a situation where the app is not idempotent. React should
        // warn but do the right thing.
        element.innerHTML = lastMarkup.replace(/<script([^]*)<\/script>/, "<span$1</span>");
        eval(element.children[1].innerHTML);

        var instance = ReactDOM.render(<TestComponent name="y" />, element);
        expect(mountCount).toEqual(4);
        expect(console.error.argsForCall.length).toBe(1);
        expect(element.innerHTML.length > 0).toBe(true);
        expect(element.innerHTML).not.toEqual(lastMarkup);

        // Ensure the events system works
        expect(numClicks).toEqual(0);
        ReactTestUtils.Simulate.click(React.findDOMNode(instance.refs.span));
        expect(numClicks).toEqual(1);

        done = true;
      }));

      waitsFor(function() {return done;});
    });

    it('should throw with silly args', function() {
      expect(
        ReactServerAsyncRendering.renderToStringStream.bind(
          ReactServerAsyncRendering,
          'not a component'
        )
      ).toThrow(
        'Invariant Violation: renderToStringStream(): You must pass ' +
        'a valid ReactElement.'
      );
    });
  });
});

describe('renderToStaticMarkupStream', function() {
  beforeEach(beforeEachFn);

  it('should generate simple markup', function() {
    expectRenderToStaticMarkupStream(
      <span>hello world</span>, 
      '<span>hello world</span>');
  });

  it('should generate simple markup for self-closing tags', function() {
    expectRenderToStaticMarkupStream(
      <img />, 
      '<img/>');
  });

  it('should generate empty markup for non self-closing tags', function() {
    expectRenderToStaticMarkupStream(
      <span></span>, 
      '<span></span>');
  });

  it('should generate simple markup for attribute with `>` symbol', function() {
    expectRenderToStaticMarkupStream(
      <img data-attr=">" />, 
      '<img data-attr="&gt;"/>');
  });

  it('should generate markup for pure functional components without props', function() {
    var HelloWorld = () => {
      return <span>hello world</span>
    };

    expectRenderToStaticMarkupStream(
      <HelloWorld/>, 
      '<span>hello world</span>');
  });

  it('should generate markup for pure functional components with props & text sections without extra spans', function() {
    var HelloWorld = ({name}) => {
      return <span>hello {name}</span>
    };

    expectRenderToStaticMarkupStream(
      <HelloWorld name="React"/>, 
      '<span>hello React</span>'
    );
  });

  it('should generate markup for arrays of components', function() {
    var Number = ({num}) => {
      return <span>{num.toString()}</span>;
    };
    var Counter = () => {
      return <div>{[<Number num={1}/>,<Number num={2}/>,<Number num={3}/>]}</div>
    };

    expectRenderToStaticMarkupStream(
      <Counter/>, 
      '<div><span>1</span><span>2</span><span>3</span></div>');
  });

  it('should add a newline for newline-eating tags', function() {
    expectRenderToStaticMarkupStream(<pre>{"\nContents"}</pre>, '<pre>\n\nContents</pre>');
    expectRenderToStaticMarkupStream(<pre>{"\nConte\nts"}</pre>, '<pre>\n\nConte\nts</pre>');
  });
  
  it('should not add a newline for non-newline-eating tags', function() {
    expectRenderToStaticMarkupStream(<div>{"\nConte\nts"}</div>, '<div>\nConte\nts</div>');
    expectRenderToStaticMarkupStream(<div>{"\nConte\nts"}</div>, '<div>\nConte\nts</div>');
  });
  
  it('should not put checksum and React ID on components', function() {
    var NestedComponent = React.createClass({
      render: function() {
        return <div>inner text</div>;
      },
    });

    var TestComponent = React.createClass({
      render: function() {
        return <span><NestedComponent /></span>;
      },
    });
    expectRenderToStaticMarkupStream(<TestComponent />, '<span><div>inner text</div></span>');
  });

  it('should not put checksum and React ID on text components', function() {
    var TestComponent = React.createClass({
      render: function() {
        return <span>{'hello'} {'world'}</span>;
      },
    });

    expectRenderToStaticMarkupStream(<TestComponent />, '<span>hello world</span>');
  });

  it('should be able to include a simple stream', function() {
    expectRenderToStaticMarkupStream(<div>{stringToStream("Hello, world!")}</div>, "<div>Hello, world!</div>");
  });

  it('should be able to self-close a tag when the child is an empty stream', function() {
    expectRenderToStaticMarkupStream(<img>{stringToStream("")}</img>, "<img/>");
    expectRenderToStaticMarkupStream(<img>{stringToStream("")}{stringToStream("")}</img>, "<img/>");
  });

  it('should be able to not self-close a tag when the child is an empty stream', function() {
    expectRenderToStaticMarkupStream(<div>{stringToStream("")}</div>, "<div></div>");
  });

  it('should add a newline for newline-eating tags in a stream', function() {
    expectRenderToStaticMarkupStream(<pre>{stringToStream("\nContents")}</pre>, '<pre>\n\nContents</pre>');
    expectRenderToStaticMarkupStream(<pre>{stringToStream("\nConte\nts")}</pre>, '<pre>\n\nConte\nts</pre>');
  });
  
  it('should not add a newline for non-newline-eating tags in a stream', function() {
    expectRenderToStaticMarkupStream(<div>{stringToStream("\nContents")}</div>, '<div>\nContents</div>');
    expectRenderToStaticMarkupStream(<div>{stringToStream("\nConte\nts")}</div>, '<div>\nConte\nts</div>');
  });
  
  it('should encode by default when including a sub-stream', function() {
    var stream = ReactServerAsyncRendering.renderToStaticMarkupStream(<span>Hello, world!</span>);
    expectRenderToStaticMarkupStream(<div>{stream}</div>, "<div>&lt;span&gt;Hello, world!&lt;/span&gt;</div>");
    expectRenderToStaticMarkupStream(<div>{stringToStream("<span>Hello</span>")}{stringToStream("<span>World</span>")}</div>, "<div>&lt;span&gt;Hello&lt;/span&gt;&lt;span&gt;World&lt;/span&gt;</div>");
    expectRenderToStaticMarkupStream(<div>{stringToStream("<span>Hello</span>")}World</div>, "<div>&lt;span&gt;Hello&lt;/span&gt;World</div>");
    expectRenderToStaticMarkupStream(<div>Hello{stringToStream("<span>World</span>")}</div>, "<div>Hello&lt;span&gt;World&lt;/span&gt;</div>");
  });

  it('should allow a stream in dangerouslySetInnerHTML', function() {
    var stream = ReactServerAsyncRendering.renderToStaticMarkupStream(<span>Hello, world!</span>);
    expectRenderToStaticMarkupStream(<div dangerouslySetInnerHTML={{__html:stream}}></div>, "<div><span>Hello, world!</span></div>");
    expectRenderToStaticMarkupStream(<div dangerouslySetInnerHTML={{__html:stringToStream("<span>Hello</span>")}}></div>, "<div><span>Hello</span></div>");
  });

  it('should be able to include a stream as a first sibling', function() {
    expectRenderToStaticMarkupStream(<div>{stringToStream("Goodbye, world!")}<span>Hello, world!</span></div>, "<div>Goodbye, world!<span>Hello, world!</span></div>");
    expectRenderToStaticMarkupStream(<div>{stringToStream("Goodbye, world!")}Hello, world!</div>, "<div>Goodbye, world!Hello, world!</div>");
  });

  it('should be able to include a stream as a last sibling', function() {
    expectRenderToStaticMarkupStream(<div><span>Hello, world!</span>{stringToStream("Goodbye, world!")}</div>, "<div><span>Hello, world!</span>Goodbye, world!</div>");
    expectRenderToStaticMarkupStream(<div>Hello, world!{stringToStream("Goodbye, world!")}</div>, "<div>Hello, world!Goodbye, world!</div>");
  });

  it('should be able to include a large stream', function() {
    var largeString = "a".repeat(50000);
    expectRenderToStaticMarkupStream(<div>{stringToStream(largeString)}</div>, "<div>" + largeString + "</div>");
    expectRenderToStaticMarkupStream(<div>{stringToStream(largeString)}{stringToStream(largeString)}</div>, "<div>" + largeString + largeString + "</div>");
  });

  it('should not register event listeners', function() {
    var EventPluginHub = require('EventPluginHub');
    var cb = mocks.getMockFunction();

    render(
      <span onClick={cb}>hello world</span>,
      ReactServerAsyncRendering.renderToStaticMarkupStream,
      (result, done) => {
        expect(EventPluginHub.__getListenerBank()).toEqual({});
        done();
      }
    );
  });

  it('should only execute certain lifecycle methods v 0.2.x', function() {
    var runCount = 0;
    function runTest() {
      var lifecycle = [];
      var TestComponent = React.createClass({
        componentWillMount: function() {
          lifecycle.push('componentWillMount');
        },
        componentDidMount: function() {
          lifecycle.push('componentDidMount');
        },
        getInitialState: function() {
          lifecycle.push('getInitialState');
          return {name: 'TestComponent'};
        },
        render: function() {
          lifecycle.push('render');
          return <span>Component name: {this.state.name}</span>;
        },
        componentWillUpdate: function() {
          lifecycle.push('componentWillUpdate');
        },
        componentDidUpdate: function() {
          lifecycle.push('componentDidUpdate');
        },
        shouldComponentUpdate: function() {
          lifecycle.push('shouldComponentUpdate');
        },
        componentWillReceiveProps: function() {
          lifecycle.push('componentWillReceiveProps');
        },
        componentWillUnmount: function() {
          lifecycle.push('componentWillUnmount');
        },
      });

      var response = ReactServerAsyncRendering.renderToStaticMarkupStream(
        <TestComponent />
      ).pipe(output((result) => {
        expect(result).toBe('<span>Component name: TestComponent</span>');
        expect(lifecycle).toEqual(
          ['getInitialState', 'componentWillMount', 'render']
        );
        runCount++;
      }));

    }

    runTest();

    // This should work the same regardless of whether you can use DOM or not.
    ExecutionEnvironment.canUseDOM = true;
    runTest();

    waitsFor(function() {return (runCount == 2);});
  });

  it('should throw with silly args', function() {
   expect(
      ReactServerAsyncRendering.renderToStaticMarkupStream.bind(
        ReactServerAsyncRendering,
        'not a component'
      )
    ).toThrow(
      'Invariant Violation: renderToStaticMarkupStream(): You must pass ' +
      'a valid ReactElement.'
    );
  });

  it('allows setState in componentWillMount without using DOM', function() {
    var done = false;

    var Component = React.createClass({
      componentWillMount: function() {
        this.setState({text: 'hello, world'});
      },
      render: function() {
        return <div>{this.state.text}</div>;
      },
    });

    ReactReconcileTransaction.prototype.perform = function() {
      // We shouldn't ever be calling this on the server
      throw new Error('Browser reconcile transaction should not be used');
    };
    ReactServerAsyncRendering.renderToStringStream(
      <Component />
    ).pipe(output((result) => {
      expect(result.indexOf('hello, world') >= 0).toBe(true);
      done = true;
    }));

    waitsFor(function() {return done;});
  });
});
