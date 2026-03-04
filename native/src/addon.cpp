#include <napi.h>
#include <libthe-seed/DependencyLister.hpp>
#include <libthe-seed/PeSigner.hpp>
#include <libthe-seed/MachOParser.hpp>
#include <libthe-seed/MachOSigner.hpp>
#include <string>
#include <vector>
#include <map>
#include <fstream>

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

// ── Format Detection ────────────────────────────────────────

Napi::Value DetectBinaryFormat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  Napi::Object result = Napi::Object::New(env);

  // Check PE first: read first 2 bytes for MZ magic, then validate PE header
  try {
    std::ifstream file(filePath, std::ios::binary);
    if (!file) {
      result.Set("format", Napi::String::New(env, "other"));
      result.Set("subFormat", env.Null());
      return result;
    }

    std::uint8_t magic[4] = {0};
    file.read(reinterpret_cast<char*>(magic), 4);
    std::size_t bytesRead = static_cast<std::size_t>(file.gcount());

    if (bytesRead < 2) {
      result.Set("format", Napi::String::New(env, "other"));
      result.Set("subFormat", env.Null());
      return result;
    }

    // Check PE: starts with MZ (0x4D5A)
    if (magic[0] == 0x4D && magic[1] == 0x5A) {
      // Validate PE header by trying to compute digest
      try {
        auto digestResult = PeSigner::ComputeAuthenticodeDigest(filePath);
        result.Set("format", Napi::String::New(env, "pe"));
        result.Set("subFormat", Napi::String::New(env, digestResult.is_pe32_plus ? "pe32+" : "pe32"));
        return result;
      } catch (...) {
        // MZ magic but invalid PE structure — fall through to other
      }
    }

    // Check Mach-O
    if (bytesRead >= 4) {
      std::uint32_t magic32 = (static_cast<std::uint32_t>(magic[0]) << 24) |
                               (static_cast<std::uint32_t>(magic[1]) << 16) |
                               (static_cast<std::uint32_t>(magic[2]) << 8) |
                               static_cast<std::uint32_t>(magic[3]);
      std::uint32_t magic32le = (static_cast<std::uint32_t>(magic[3]) << 24) |
                                 (static_cast<std::uint32_t>(magic[2]) << 16) |
                                 (static_cast<std::uint32_t>(magic[1]) << 8) |
                                 static_cast<std::uint32_t>(magic[0]);

      // Mach-O magics: FEEDFACE (32), FEEDFACF (64), CAFEBABE (fat), reverse endian variants
      bool isMacho = (magic32 == 0xFEEDFACE || magic32 == 0xFEEDFACF ||
                      magic32 == 0xCAFEBABE || magic32le == 0xFEEDFACE ||
                      magic32le == 0xFEEDFACF);

      if (isMacho) {
        auto fmt = MachOParser::DetectFormat(filePath);
        result.Set("format", Napi::String::New(env, "macho"));
        switch (fmt) {
          case MachOParser::Format::MachO32:
            result.Set("subFormat", Napi::String::New(env, "macho32"));
            break;
          case MachOParser::Format::MachO64:
            result.Set("subFormat", Napi::String::New(env, "macho64"));
            break;
          case MachOParser::Format::Fat:
            result.Set("subFormat", Napi::String::New(env, "fat"));
            break;
          default:
            result.Set("subFormat", env.Null());
            break;
        }
        return result;
      }
    }

    result.Set("format", Napi::String::New(env, "other"));
    result.Set("subFormat", env.Null());
    return result;

  } catch (const std::exception& e) {
    result.Set("format", Napi::String::New(env, "other"));
    result.Set("subFormat", env.Null());
    return result;
  }
}

// ── PE Signing Operations ───────────────────────────────────

Napi::Value PeComputeDigest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto result = PeSigner::ComputeAuthenticodeDigest(filePath);
    Napi::Object jsResult = Napi::Object::New(env);
    jsResult.Set("digest", Napi::Buffer<uint8_t>::Copy(env, result.digest.data(), result.digest.size()));
    jsResult.Set("isPe32Plus", Napi::Boolean::New(env, result.is_pe32_plus));
    return jsResult;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value PeEmbedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "Expected (filePath: string, pkcs7Der: Buffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  std::vector<uint8_t> pkcs7Der(buf.Data(), buf.Data() + buf.Length());

  try {
    PeSigner::EmbedSignature(filePath, pkcs7Der);
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value PeExtractSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto result = PeSigner::ExtractSignature(filePath);
    if (result.has_value()) {
      return Napi::Buffer<uint8_t>::Copy(env, result->data(), result->size());
    }
    return env.Null();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value PeHasEmbeddedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    return Napi::Boolean::New(env, PeSigner::HasEmbeddedSignature(filePath));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// ── Mach-O Signing Operations ───────────────────────────────

Napi::Value MachOComputeCodeDirectory(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Expected (filePath: string, identity: string)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  std::string identity = info[1].As<Napi::String>().Utf8Value();

  try {
    auto result = MachOSigner::ComputeCodeDirectory(filePath, identity);
    Napi::Object jsResult = Napi::Object::New(env);
    jsResult.Set("codeDirectory", Napi::Buffer<uint8_t>::Copy(env, result.code_directory.data(), result.code_directory.size()));
    jsResult.Set("cdHash", Napi::Buffer<uint8_t>::Copy(env, result.cd_hash.data(), result.cd_hash.size()));
    return jsResult;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOBuildSuperBlob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "Expected (codeDirectory: Buffer, cmsSignature: Buffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> cdBuf = info[0].As<Napi::Buffer<uint8_t>>();
  Napi::Buffer<uint8_t> cmsBuf = info[1].As<Napi::Buffer<uint8_t>>();

  std::vector<uint8_t> codeDirectory(cdBuf.Data(), cdBuf.Data() + cdBuf.Length());
  std::vector<uint8_t> cmsSignature(cmsBuf.Data(), cmsBuf.Data() + cmsBuf.Length());

  try {
    auto result = MachOSigner::BuildSuperBlob(codeDirectory, cmsSignature);
    return Napi::Buffer<uint8_t>::Copy(env, result.data(), result.size());
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOEmbedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "Expected (filePath: string, superBlob: Buffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  std::vector<uint8_t> superBlob(buf.Data(), buf.Data() + buf.Length());

  try {
    MachOSigner::EmbedSignature(filePath, superBlob);
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOExtractSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto result = MachOSigner::ExtractSignature(filePath);
    if (result.has_value()) {
      return Napi::Buffer<uint8_t>::Copy(env, result->data(), result->size());
    }
    return env.Null();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOHasEmbeddedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    return Napi::Boolean::New(env, MachOSigner::HasEmbeddedSignature(filePath));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDependencies", Napi::Function::New(env, ListDependencies));

  // Format detection
  exports.Set("detectBinaryFormat", Napi::Function::New(env, DetectBinaryFormat));

  // PE signing operations
  exports.Set("peComputeDigest", Napi::Function::New(env, PeComputeDigest));
  exports.Set("peEmbedSignature", Napi::Function::New(env, PeEmbedSignature));
  exports.Set("peExtractSignature", Napi::Function::New(env, PeExtractSignature));
  exports.Set("peHasEmbeddedSignature", Napi::Function::New(env, PeHasEmbeddedSignature));

  // Mach-O signing operations
  exports.Set("machoComputeCodeDirectory", Napi::Function::New(env, MachOComputeCodeDirectory));
  exports.Set("machoBuildSuperBlob", Napi::Function::New(env, MachOBuildSuperBlob));
  exports.Set("machoEmbedSignature", Napi::Function::New(env, MachOEmbedSignature));
  exports.Set("machoExtractSignature", Napi::Function::New(env, MachOExtractSignature));
  exports.Set("machoHasEmbeddedSignature", Napi::Function::New(env, MachOHasEmbeddedSignature));

  return exports;
}

NODE_API_MODULE(dependency_lister, Init)
