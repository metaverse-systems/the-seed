{
  "targets": [
    {
      "target_name": "dependency_lister",
      "sources": ["src/addon.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(pkg-config --cflags-only-I 'the-seed >= 0.8.0' | sed 's/-I//g')"
      ],
      "libraries": [
        "<!@(pkg-config --libs 'the-seed >= 0.8.0')",
        "<!@(pkg-config --libs-only-L 'the-seed >= 0.8.0' | sed 's/-L/-Wl,-rpath,/g')"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      # gyp takes only the include directories from the package metadata; the addon's own code needs the language level.
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
