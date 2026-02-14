{
  "targets": [
    {
      "target_name": "dependency_lister",
      "sources": ["src/addon.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(pkg-config --cflags-only-I the-seed | sed 's/-I//g')"
      ],
      "libraries": [
        "<!@(pkg-config --libs the-seed)",
        "<!@(pkg-config --libs-only-L the-seed | sed 's/-L/-Wl,-rpath,/g')"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
