#include <napi.h>
#include <libthe-seed/DependencyLister.hpp>
#include <string>
#include <vector>
#include <map>

Napi::Value ListDependencies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "Expected two array arguments: binaryPaths, searchPaths")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array jsBinaryPaths = info[0].As<Napi::Array>();
  Napi::Array jsSearchPaths = info[1].As<Napi::Array>();

  std::vector<std::string> binaryPaths;
  for (uint32_t i = 0; i < jsBinaryPaths.Length(); i++) {
    binaryPaths.push_back(jsBinaryPaths.Get(i).As<Napi::String>().Utf8Value());
  }

  std::vector<std::string> searchPaths;
  for (uint32_t i = 0; i < jsSearchPaths.Length(); i++) {
    searchPaths.push_back(jsSearchPaths.Get(i).As<Napi::String>().Utf8Value());
  }

  DependencyLister lister;
  auto result = lister.ListDependencies(binaryPaths, searchPaths);

  Napi::Object jsResult = Napi::Object::New(env);

  // Convert dependencies map: Record<string, string[]>
  Napi::Object jsDeps = Napi::Object::New(env);
  for (const auto& [libPath, dependents] : result.dependencies) {
    Napi::Array jsDependents = Napi::Array::New(env, dependents.size());
    for (size_t i = 0; i < dependents.size(); i++) {
      jsDependents.Set(i, Napi::String::New(env, dependents[i]));
    }
    jsDeps.Set(libPath, jsDependents);
  }
  jsResult.Set("dependencies", jsDeps);

  // Convert errors map: Record<string, string>
  Napi::Object jsErrors = Napi::Object::New(env);
  for (const auto& [binaryPath, errorMsg] : result.errors) {
    jsErrors.Set(binaryPath, Napi::String::New(env, errorMsg));
  }
  jsResult.Set("errors", jsErrors);

  return jsResult;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDependencies", Napi::Function::New(env, ListDependencies));
  return exports;
}

NODE_API_MODULE(dependency_lister, Init)
