# Build file for the vendored SIGFM matcher (third-party, LGPL-2.1+).
# Place this directory at libfprint/sigfm/ inside the libfprint source tree.
sigfm_sources = ['sigfm.cpp']

opencv = dependency('opencv4', required: true, version: '>=4.5.0')

libsigfm = static_library('sigfm',
    sigfm_sources,
    dependencies: [opencv],
    install: false)

sigfm_dep = declare_dependency(
    link_with: libsigfm,
    include_directories: include_directories('..'),
    dependencies: [opencv])
