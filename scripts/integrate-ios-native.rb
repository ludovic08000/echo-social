#!/usr/bin/env ruby
# frozen_string_literal: true

require 'xcodeproj'

root = File.expand_path('..', __dir__)
project_path = File.join(root, 'ios', 'App', 'App.xcodeproj')
app_dir = File.join(root, 'ios', 'App', 'App')
framework_path = File.join(root, 'ios', 'App', 'Frameworks', 'AegisCrypto.xcframework')
storyboard_path = File.join(app_dir, 'Base.lproj', 'Main.storyboard')

abort "Missing Xcode project: #{project_path}" unless Dir.exist?(project_path)
abort "Missing AegisCrypto XCFramework: #{framework_path}" unless Dir.exist?(framework_path)

project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |candidate| candidate.name == 'App' }
abort 'App target not found' unless target

app_group = project.main_group.find_subpath('App', true)
frameworks_group = project.main_group.find_subpath('Frameworks', true)
# find_subpath creates a visual group with no filesystem path. Give it the
# real directory used by bootstrap-ios-native.sh so the XCFramework reference
# resolves to ios/App/Frameworks/AegisCrypto.xcframework.
frameworks_group.path = 'Frameworks' if frameworks_group.path.nil? || frameworks_group.path.empty?

swift_files = %w[
  AegisKeychainPlugin.swift
  AegisCryptoNative.swift
  LibSignalPlugin.swift
  ContactsPlugin.swift
  BridgeViewController.swift
]

swift_files.each do |filename|
  absolute = File.join(app_dir, filename)
  abort "Missing iOS source: #{absolute}" unless File.file?(absolute)

  reference = project.files.find do |file|
    begin
      File.expand_path(file.real_path.to_s) == absolute
    rescue StandardError
      false
    end
  end
  reference ||= app_group.new_file(filename)

  unless target.source_build_phase.files_references.include?(reference)
    target.source_build_phase.add_file_reference(reference, true)
  end
end

framework_reference = project.files.find do |file|
  begin
    File.expand_path(file.real_path.to_s) == framework_path
  rescue StandardError
    false
  end
end
framework_reference ||= frameworks_group.new_file('AegisCrypto.xcframework')

# xcodeproj does not currently infer .xcframework in FILE_TYPES_BY_EXTENSION.
# Xcode needs wrapper.xcframework here to emit ProcessXCFramework and expose
# the AegisCrypto Clang module to Swift before compiling App.
framework_reference.explicit_file_type = nil
framework_reference.last_known_file_type = 'wrapper.xcframework'

resolved_framework_path = File.expand_path(framework_reference.real_path.to_s)
abort "AegisCrypto XCFramework reference resolves to #{resolved_framework_path}, expected #{framework_path}" unless resolved_framework_path == framework_path

unless target.frameworks_build_phase.files_references.include?(framework_reference)
  target.frameworks_build_phase.add_file_reference(framework_reference, true)
end

# Xcode 26 can process a static-library XCFramework and copy module.modulemap
# into BUILT_PRODUCTS_DIR/include without copying the sibling C header. Swift's
# explicit module scanner then finds AegisCrypto but fails with
# "header 'aegis_crypto.h' not found". Stage the public header (and matching
# module map) into that exact product include directory before Compile Sources.
header_phase = target.shell_script_build_phases.find { |phase| phase.name == 'Prepare AegisCrypto Headers' }
header_phase ||= target.new_shell_script_build_phase('Prepare AegisCrypto Headers')
header_phase.shell_path = '/bin/bash'
header_phase.input_paths = [
  '$(SRCROOT)/../../include/AegisCrypto/aegis_crypto.h',
  '$(SRCROOT)/../../include/AegisCrypto/module.modulemap'
]
header_phase.output_paths = [
  '$(BUILT_PRODUCTS_DIR)/include/aegis_crypto.h',
  '$(BUILT_PRODUCTS_DIR)/include/module.modulemap'
]
header_phase.shell_script = <<~'SCRIPT'
  set -euo pipefail
  source_dir="${SRCROOT}/../../include/AegisCrypto"
  destination_dir="${BUILT_PRODUCTS_DIR}/include"
  mkdir -p "${destination_dir}"
  cp "${source_dir}/aegis_crypto.h" "${destination_dir}/aegis_crypto.h"
  cp "${source_dir}/module.modulemap" "${destination_dir}/module.modulemap"
  test -s "${destination_dir}/aegis_crypto.h"
  test -s "${destination_dir}/module.modulemap"
SCRIPT

# Build-phase ordering matters with Xcode 26 explicit module dependency scans.
# Ensure the header staging task is ordered before the Swift Compile Sources
# phase rather than leaving a newly-created shell phase at the end of the target.
target.build_phases.delete(header_phase)
source_phase_index = target.build_phases.index(target.source_build_phase) || 0
target.build_phases.insert(source_phase_index, header_phase)

# AegisCrypto is a static XCFramework. It must be linked, never embedded.
target.build_configurations.each do |config|
  config.build_settings['SWIFT_VERSION'] = '5.0'
end

project.save

abort "Missing storyboard: #{storyboard_path}" unless File.file?(storyboard_path)
storyboard = File.read(storyboard_path)

if storyboard.include?('customClass="CAPBridgeViewController"')
  storyboard = storyboard.sub(
    'customClass="CAPBridgeViewController"',
    'customClass="BridgeViewController" customModule="App" customModuleProvider="target"'
  )
elsif !storyboard.include?('customClass="BridgeViewController"')
  abort 'CAPBridgeViewController entry point not found in Main.storyboard'
end

File.write(storyboard_path, storyboard)
puts "AegisCrypto XCFramework integrated at #{resolved_framework_path}."
