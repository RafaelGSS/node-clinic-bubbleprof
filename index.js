'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const pump = require('pump')
const { spawn } = require('child_process')
const analysis = require('./analysis/index.js')
const Stringify = require('streaming-json-stringify')
const browserify = require('browserify')
const streamTemplate = require('stream-template')
const getLoggingPaths = require('./collect/get-logging-paths.js')
const SystemInfoDecoder = require('./format/system-info-decoder.js')
const StackTraceDecoder = require('./format/stack-trace-decoder.js')
const TraceEventDecoder = require('./format/trace-event-decoder.js')

class ClinicBubbleprof {
  collect (args, callback) {
    const samplerPath = path.resolve(__dirname, 'logger.js')

    // run program, but inject the sampler
    const logArgs = [
      '-r', samplerPath,
      '--trace-events-enabled', '--trace-event-categories', 'node.async_hooks'
    ]
    const proc = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: Object.assign({}, process.env, {
        NODE_OPTIONS: logArgs.join(' ') + (
          process.env.NODE_OPTIONS ? ' ' + process.env.NODE_OPTIONS : ''
        )
      })
    })

    // get filenames of logfiles
    const paths = getLoggingPaths({ identifier: proc.pid })

    // relay SIGINT to process
    process.once('SIGINT', () => proc.kill('SIGINT'))

    proc.once('exit', function (code, signal) {
      // Windows exit code STATUS_CONTROL_C_EXIT 0xC000013A returns 3221225786
      // if not caught. See https://msdn.microsoft.com/en-us/library/cc704588.aspx
      /* istanbul ignore next: windows hack */
      if (code === 3221225786 && os.platform() === 'win32') signal = 'SIGINT'

      // the process did not exit normally
      if (code !== 0 && signal !== 'SIGINT') {
        if (code !== null) {
          return callback(
            new Error(`process exited with exit code ${code}`),
            paths['/']
          )
        } else {
          return callback(
            new Error(`process exited by signal ${signal}`),
            paths['/']
          )
        }
      }

      // create directory and move files to that directory
      fs.rename(
        'node_trace.1.log', paths['/traceevent'],
        function (err) {
          if (err) return callback(err, paths['/'])
          callback(null, paths['/'])
        }
      )
    })
  }

  visualize (dataDirname, outputFilename, callback) {
    const fakeDataPath = path.join(__dirname, 'visualizer', 'data.json')
    const stylePath = path.join(__dirname, 'visualizer', 'style.css')
    const scriptPath = path.join(__dirname, 'visualizer', 'main.js')
    const nearFormLogoPath = path.join(__dirname, 'visualizer', 'nearform-logo.svg')

    // Load data
    const paths = getLoggingPaths({ path: dataDirname })
    const systemInfoReader = fs.createReadStream(paths['/systeminfo'])
      .pipe(new SystemInfoDecoder())
    const stackTraceReader = fs.createReadStream(paths['/stacktrace'])
      .pipe(new StackTraceDecoder())
    const traceEventReader = fs.createReadStream(paths['/traceevent'])
      .pipe(new TraceEventDecoder())

    // create dataFile
    const dataFile = analysis(
      systemInfoReader, stackTraceReader, traceEventReader
    ).pipe(new Stringify({
      seperator: ',\n',
      stringifier: JSON.stringify
    }))

    // add logos
    const nearFormLogoFile = fs.createReadStream(nearFormLogoPath)

    // create script-file stream
    const b = browserify({
      'basedir': __dirname,
      // 'debug': true,
      'noParse': [fakeDataPath]
    })
    b.transform('brfs')
    b.require(dataFile, {
      'file': fakeDataPath
    })
    b.add(scriptPath)
    const scriptFile = b.bundle()

    // create style-file stream
    const styleFile = fs.createReadStream(stylePath)

    // build output file
    const outputFile = streamTemplate`
      <!DOCTYPE html>
      <meta charset="utf8">
      <title>Clinic Bubbleprof</title>
      <style>${styleFile}</style>
      <div id="banner">${nearFormLogoFile}</div>
      <script>${scriptFile}</script>
    `

    pump(
      outputFile,
      fs.createWriteStream(outputFilename),
      callback
    )
  }
}

module.exports = ClinicBubbleprof
