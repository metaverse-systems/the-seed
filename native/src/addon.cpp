#include <napi.h>
#include <libthe-seed/DependencyLister.hpp>
#include <libthe-seed/PeSigner.hpp>
#include <libthe-seed/MachOParser.hpp>
#include <libthe-seed/MachOSigner.hpp>
#include <libthe-seed/MsiSigner.hpp>
#include <cmath>
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

  // Convert libraryErrors map: Record<string, { reason: string, inputs: string[] }>
  Napi::Object jsLibraryErrors = Napi::Object::New(env);
  for (const auto& [libPath, libraryError] : result.libraryErrors) {
    Napi::Object jsEntry = Napi::Object::New(env);
    jsEntry.Set("reason", Napi::String::New(env, libraryError.reason));
    Napi::Array jsInputs = Napi::Array::New(env, libraryError.inputs.size());
    for (size_t i = 0; i < libraryError.inputs.size(); i++) {
      jsInputs.Set(i, Napi::String::New(env, libraryError.inputs[i]));
    }
    jsEntry.Set("inputs", jsInputs);
    jsLibraryErrors.Set(libPath, jsEntry);
  }
  jsResult.Set("libraryErrors", jsLibraryErrors);

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

    // Check Mach-O: the library decides, from the same rules it signs by
    if (bytesRead >= 4) {
      MachOParser::Format fmt = MachOParser::Format::NotMachO;
      try {
        fmt = MachOParser::DetectFormat(filePath);
      } catch (...) {
        fmt = MachOParser::Format::NotMachO;
      }

      if (fmt != MachOParser::Format::NotMachO) {
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

      // Check OLE/CFBF (MSI): magic D0 CF 11 E0 A1 B1 1A E1
      if (magic[0] == 0xD0 && magic[1] == 0xCF && magic[2] == 0x11 && magic[3] == 0xE0) {
        // Read remaining 4 magic bytes
        std::uint8_t magic2[4] = {0};
        file.read(reinterpret_cast<char*>(magic2), 4);
        if (file.gcount() >= 4 &&
            magic2[0] == 0xA1 && magic2[1] == 0xB1 &&
            magic2[2] == 0x1A && magic2[3] == 0xE1) {
          result.Set("format", Napi::String::New(env, "msi"));
          result.Set("subFormat", env.Null());
          return result;
        }
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

// Reads the prepared-signature object that machoPrepareSignature returned.
// Throws Napi::TypeError naming the first missing or mistyped field.
static MachOSigner::PreparedSignature ReadPreparedSignature(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsArray() || value.IsBuffer()) {
    throw Napi::TypeError::New(env, "prepared must be the object returned by machoPrepareSignature");
  }
  Napi::Object obj = value.As<Napi::Object>();

  Napi::Value identity = obj.Get("identity");
  if (!identity.IsString()) {
    throw Napi::TypeError::New(env, "prepared.identity must be a string");
  }
  Napi::Value capacity = obj.Get("cmsCapacity");
  if (!capacity.IsNumber()) {
    throw Napi::TypeError::New(env, "prepared.cmsCapacity must be a number");
  }
  double capValue = capacity.As<Napi::Number>().DoubleValue();
  if (!(capValue >= 0) || capValue >= 2147483648.0 || capValue != std::floor(capValue)) {
    throw Napi::TypeError::New(env, "prepared.cmsCapacity must be a non-negative integer below 2^31");
  }
  Napi::Value slices = obj.Get("slices");
  if (!slices.IsArray()) {
    throw Napi::TypeError::New(env, "prepared.slices must be an array");
  }

  MachOSigner::PreparedSignature prepared;
  prepared.identity = identity.As<Napi::String>().Utf8Value();
  prepared.cms_capacity = static_cast<std::uint32_t>(capValue);

  Napi::Array sliceArray = slices.As<Napi::Array>();
  for (uint32_t i = 0; i < sliceArray.Length(); i++) {
    std::string where = "prepared.slices[" + std::to_string(i) + "]";
    Napi::Value item = sliceArray.Get(i);
    if (!item.IsObject()) {
      throw Napi::TypeError::New(env, where + " must be an object");
    }
    Napi::Object sliceObj = item.As<Napi::Object>();

    Napi::Value cpuType = sliceObj.Get("cpuType");
    if (!cpuType.IsNumber()) {
      throw Napi::TypeError::New(env, where + ".cpuType must be a number");
    }
    Napi::Value cpuSubtype = sliceObj.Get("cpuSubtype");
    if (!cpuSubtype.IsNumber()) {
      throw Napi::TypeError::New(env, where + ".cpuSubtype must be a number");
    }
    Napi::Value codeDirectory = sliceObj.Get("codeDirectory");
    if (!codeDirectory.IsBuffer()) {
      throw Napi::TypeError::New(env, where + ".codeDirectory must be a Buffer");
    }
    Napi::Value cdHash = sliceObj.Get("cdHash");
    if (!cdHash.IsBuffer()) {
      throw Napi::TypeError::New(env, where + ".cdHash must be a Buffer");
    }

    MachOSigner::PreparedSlice slice;
    slice.cpu_type = static_cast<std::uint32_t>(cpuType.As<Napi::Number>().Int64Value());
    slice.cpu_subtype = static_cast<std::uint32_t>(cpuSubtype.As<Napi::Number>().Int64Value());
    Napi::Buffer<uint8_t> cdBuf = codeDirectory.As<Napi::Buffer<uint8_t>>();
    slice.code_directory.assign(cdBuf.Data(), cdBuf.Data() + cdBuf.Length());
    Napi::Buffer<uint8_t> hashBuf = cdHash.As<Napi::Buffer<uint8_t>>();
    slice.cd_hash.assign(hashBuf.Data(), hashBuf.Data() + hashBuf.Length());
    prepared.slices.push_back(std::move(slice));
  }
  return prepared;
}

Napi::Value MachOPrepareSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "Expected (filePath: string, identity: string, cmsCapacity: number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  std::string identity = info[1].As<Napi::String>().Utf8Value();
  double capValue = info[2].As<Napi::Number>().DoubleValue();
  if (!(capValue >= 0) || capValue >= 2147483648.0 || capValue != std::floor(capValue)) {
    Napi::TypeError::New(env, "cmsCapacity must be a non-negative integer below 2^31")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    auto prepared = MachOSigner::PrepareSignature(filePath, identity, static_cast<std::uint32_t>(capValue));
    Napi::Object jsResult = Napi::Object::New(env);
    jsResult.Set("identity", Napi::String::New(env, prepared.identity));
    jsResult.Set("cmsCapacity", Napi::Number::New(env, static_cast<double>(prepared.cms_capacity)));
    Napi::Array slices = Napi::Array::New(env, prepared.slices.size());
    for (size_t i = 0; i < prepared.slices.size(); i++) {
      const auto& slice = prepared.slices[i];
      Napi::Object jsSlice = Napi::Object::New(env);
      jsSlice.Set("cpuType", Napi::Number::New(env, static_cast<double>(slice.cpu_type)));
      jsSlice.Set("cpuSubtype", Napi::Number::New(env, static_cast<double>(slice.cpu_subtype)));
      jsSlice.Set("codeDirectory", Napi::Buffer<uint8_t>::Copy(env, slice.code_directory.data(), slice.code_directory.size()));
      jsSlice.Set("cdHash", Napi::Buffer<uint8_t>::Copy(env, slice.cd_hash.data(), slice.cd_hash.size()));
      slices.Set(static_cast<uint32_t>(i), jsSlice);
    }
    jsResult.Set("slices", slices);
    return jsResult;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOCompleteSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsString() || !info[2].IsArray()) {
    Napi::TypeError::New(env, "Expected (filePath: string, prepared: object, cmsSignatures: Buffer[])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  MachOSigner::PreparedSignature prepared;
  try {
    prepared = ReadPreparedSignature(env, info[1]);
  } catch (const Napi::Error& e) {
    e.ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array cmsArray = info[2].As<Napi::Array>();
  std::vector<std::vector<std::uint8_t>> cmsSignatures;
  for (uint32_t i = 0; i < cmsArray.Length(); i++) {
    Napi::Value item = cmsArray.Get(i);
    if (!item.IsBuffer()) {
      Napi::TypeError::New(env, "cmsSignatures[" + std::to_string(i) + "] must be a Buffer")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    Napi::Buffer<uint8_t> buf = item.As<Napi::Buffer<uint8_t>>();
    cmsSignatures.emplace_back(buf.Data(), buf.Data() + buf.Length());
  }

  try {
    MachOSigner::CompleteSignature(filePath, prepared, cmsSignatures);
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MachOStripSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (filePath: string)").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    MachOSigner::StripSignature(filePath);
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Removed in libthe-seed 0.6.0: the CodeDirectory must be computed after the
// file reaches its final layout, so these two calls never run.
static Napi::Value ThrowRemoved(const Napi::CallbackInfo& info, const char* name) {
  Napi::Env env = info.Env();
  Napi::Error::New(env, std::string(name) +
                            " was removed in libthe-seed 0.6.0: use machoPrepareSignature and machoCompleteSignature")
      .ThrowAsJavaScriptException();
  return env.Null();
}

Napi::Value MachOComputeCodeDirectory(const Napi::CallbackInfo& info) {
  return ThrowRemoved(info, "machoComputeCodeDirectory");
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
  return ThrowRemoved(info, "machoEmbedSignature");
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

// ── MSI Signing Operations ──────────────────────────────────

Napi::Value MsiIsMsi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    return Napi::Boolean::New(env, MsiSigner::IsMsi(filePath));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiComputeDigest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto result = MsiSigner::ComputeAuthenticodeDigest(filePath);
    Napi::Object jsResult = Napi::Object::New(env);
    jsResult.Set("digest", Napi::Buffer<uint8_t>::Copy(env, result.digest.data(), result.digest.size()));
    return jsResult;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiEmbedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "Expected (filePath: string, pkcs7Der: Buffer, requireMatchingDigest?: boolean)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  bool requireMatchingDigest = false;
  if (info.Length() >= 3 && !info[2].IsUndefined()) {
    if (!info[2].IsBoolean()) {
      Napi::TypeError::New(env, "requireMatchingDigest must be a boolean")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    requireMatchingDigest = info[2].As<Napi::Boolean>().Value();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  std::vector<uint8_t> pkcs7Der(buf.Data(), buf.Data() + buf.Length());

  try {
    MsiSigner::EmbedSignature(filePath, pkcs7Der, requireMatchingDigest);
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiCheckSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto check = MsiSigner::CheckSignature(filePath);
    const char* state = "none";
    switch (check.state) {
      case MsiSigner::SignatureState::None: state = "none"; break;
      case MsiSigner::SignatureState::Matches: state = "matches"; break;
      case MsiSigner::SignatureState::Mismatch: state = "mismatch"; break;
      case MsiSigner::SignatureState::Unreadable: state = "unreadable"; break;
    }
    Napi::Object jsResult = Napi::Object::New(env);
    jsResult.Set("state", Napi::String::New(env, state));
    jsResult.Set("storedDigest", Napi::Buffer<uint8_t>::Copy(env, check.stored_digest.data(), check.stored_digest.size()));
    jsResult.Set("computedDigest", Napi::Buffer<uint8_t>::Copy(env, check.computed_digest.data(), check.computed_digest.size()));
    jsResult.Set("detail", Napi::String::New(env, check.detail));
    return jsResult;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiStripSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    return Napi::Boolean::New(env, MsiSigner::StripSignature(filePath));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiExtractSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    auto result = MsiSigner::ExtractSignature(filePath);
    if (result.has_value()) {
      return Napi::Buffer<uint8_t>::Copy(env, result->data(), result->size());
    }
    return env.Null();
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

Napi::Value MsiHasEmbeddedSignature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected one string argument: filePath")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string filePath = info[0].As<Napi::String>().Utf8Value();

  try {
    return Napi::Boolean::New(env, MsiSigner::HasEmbeddedSignature(filePath));
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
  exports.Set("machoPrepareSignature", Napi::Function::New(env, MachOPrepareSignature));
  exports.Set("machoCompleteSignature", Napi::Function::New(env, MachOCompleteSignature));
  exports.Set("machoStripSignature", Napi::Function::New(env, MachOStripSignature));
  exports.Set("machoComputeCodeDirectory", Napi::Function::New(env, MachOComputeCodeDirectory));
  exports.Set("machoBuildSuperBlob", Napi::Function::New(env, MachOBuildSuperBlob));
  exports.Set("machoEmbedSignature", Napi::Function::New(env, MachOEmbedSignature));
  exports.Set("machoExtractSignature", Napi::Function::New(env, MachOExtractSignature));
  exports.Set("machoHasEmbeddedSignature", Napi::Function::New(env, MachOHasEmbeddedSignature));

  // MSI signing operations
  exports.Set("msiIsMsi", Napi::Function::New(env, MsiIsMsi));
  exports.Set("msiComputeDigest", Napi::Function::New(env, MsiComputeDigest));
  exports.Set("msiEmbedSignature", Napi::Function::New(env, MsiEmbedSignature));
  exports.Set("msiCheckSignature", Napi::Function::New(env, MsiCheckSignature));
  exports.Set("msiStripSignature", Napi::Function::New(env, MsiStripSignature));
  exports.Set("msiExtractSignature", Napi::Function::New(env, MsiExtractSignature));
  exports.Set("msiHasEmbeddedSignature", Napi::Function::New(env, MsiHasEmbeddedSignature));

  return exports;
}

NODE_API_MODULE(dependency_lister, Init)
