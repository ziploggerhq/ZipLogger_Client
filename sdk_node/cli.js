#!/usr/bin/env node
'use strict'

// `npx ziplogger …` — see cli-core.js and `ziplogger --help`.
require('./cli-core.js').main(process.argv.slice(2)).then(code => { process.exitCode = code })
