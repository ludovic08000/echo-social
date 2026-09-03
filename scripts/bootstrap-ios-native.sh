#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bootstrap-ios-native.sh requires macOS/Xcode" >&2
  exit 1
fi

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js/npm are required" >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null; then
  echo "Xcode command line tools are required" >&2
  exit 1
fi
if ! command -v protoc >/dev/null; then
  if command -v brew >/dev/null; then
    brew install protobuf
  else
    echo "protoc is required (install protobuf)" >&2
    exit 1
  fi
fi

[[ -d node_modules ]] || npm ci

# Build and typecheck against the repository lockfile before touching the native
# plugin installation. This keeps the application dependency graph exactly the
# same as the other CI jobs.
npm run build

# The repository currently carries a mixed Capacitor plugin lock (v7/v8).
# SwiftPM cannot resolve one app when plugins require both
# capacitor-swift-pm 7.x and 8.x. Normalize only the native packages consumed
# by the generated iOS project to the same major as @capacitor/core/@capacitor/ios
# (v8), without rewriting the repository lockfile during CI.
npm install --no-save --package-lock=false \
  @capacitor-community/contacts@8.0.0 \
  @capacitor/app@8.1.1 \
  @capacitor/preferences@8.0.1 \
  @capacitor/share@8.0.1

# The historical repository contains app-target Swift sources but no generated
# Xcode project. Preserve those sources while Capacitor creates the shell.
CUSTOM_DIR="$(mktemp -d)"
trap 'rm -rf "$CUSTOM_DIR"' EXIT
if compgen -G "ios/App/App/*.swift" >/dev/null; then
  cp ios/App/App/*.swift "$CUSTOM_DIR"/
fi

if [[ ! -d ios/App/App.xcodeproj ]]; then
  rm -rf ios
  npx cap add ios
fi

mkdir -p ios/App/App
if compgen -G "$CUSTOM_DIR/*.swift" >/dev/null; then
  cp "$CUSTOM_DIR"/*.swift ios/App/App/
fi
npx cap sync ios

TOOLCHAIN="nightly-2026-07-15"
rustup toolchain install "$TOOLCHAIN" --profile minimal
rustup target add --toolchain "$TOOLCHAIN" \
  aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

pushd native/aegis-crypto >/dev/null
cargo +"$TOOLCHAIN" test --locked
cargo +"$TOOLCHAIN" build --locked --release --target aarch64-apple-ios
cargo +"$TOOLCHAIN" build --locked --release --target aarch64-apple-ios-sim
cargo +"$TOOLCHAIN" build --locked --release --target x86_64-apple-ios
popd >/dev/null

rm -rf build/ios include/AegisCrypto ios/App/Frameworks/AegisCrypto.xcframework
mkdir -p build/ios include/AegisCrypto ios/App/Frameworks
cp native/aegis-crypto/include/aegis_crypto.h include/AegisCrypto/
# This XCFramework wraps static libraries, not .framework bundles. Declaring a
# plain Clang module lets Xcode resolve the sibling header after ProcessXCFramework.
printf 'module AegisCrypto {\n  header "aegis_crypto.h"\n  export *\n}\n' > include/AegisCrypto/module.modulemap

lipo -create \
  native/aegis-crypto/target/aarch64-apple-ios-sim/release/libaegis_crypto.a \
  native/aegis-crypto/target/x86_64-apple-ios/release/libaegis_crypto.a \
  -output build/ios/libaegis_crypto-simulator.a

xcodebuild -create-xcframework \
  -library native/aegis-crypto/target/aarch64-apple-ios/release/libaegis_crypto.a \
  -headers include/AegisCrypto \
  -library build/ios/libaegis_crypto-simulator.a \
  -headers include/AegisCrypto \
  -output build/ios/AegisCrypto.xcframework

cp -R build/ios/AegisCrypto.xcframework ios/App/Frameworks/

ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --no-document
ruby scripts/integrate-ios-native.rb

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "iOS native libsignal integration built successfully."
