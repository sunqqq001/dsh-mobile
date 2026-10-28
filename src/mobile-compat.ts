// Standalone browser entry: run before DSH evaluates its boot scripts or plugins.
import 'core-js/es/iterator/index.js'
import 'core-js/actual/iterator/join.js'
import 'core-js/es/promise/with-resolvers.js'
import 'core-js/es/object/has-own.js'
import 'core-js/es/array/at.js'
import 'core-js/es/string/at.js'
import 'core-js/es/array/find-last.js'
import 'core-js/es/array/find-last-index.js'
import 'core-js/es/array/to-sorted.js'
import 'core-js/es/array/to-reversed.js'
import 'core-js/stable/structured-clone.js'
import { installAbortSignalCompatibility } from './mobile-abort-signal.js'
import { installMobileBootFeedback } from './mobile-boot-feedback.js'

installAbortSignalCompatibility()
installMobileBootFeedback()
