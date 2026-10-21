{
  "targets": [
    {
      "target_name": "the_seed_native",
      "sources": ["src/addon.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(node pkg-config.js --cflags-only-I 'the-seed >= 0.8.0' | sed 's/-I//g')"
      ],
      # The helper searches the configured install prefix first, then PKG_CONFIG_PATH, then the system directories.
      "libraries": [
        "<!@(node pkg-config.js --libs 'the-seed >= 0.8.0')",
        "<!@(node pkg-config.js --libs-only-L 'the-seed >= 0.8.0' | sed 's/-L/-Wl,-rpath,/g')"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      # gyp takes only the include directories from the package metadata; the addon's own code needs the language level.
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
