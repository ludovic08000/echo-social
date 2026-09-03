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
# Xcode needs wrapper.xcframework here to emit ProcessXCFramework before Swift
# compiles the App target.
framework_reference.explicit_file_type = nil
framework_reference.last_known_file_type = 'wrapper.xcframework'

resolved_framework_path = File.expand_path(framework_reference.real_path.to_s)
abort "AegisCrypto XCFramework reference resolves to #{resolved_framework_path}, expected #{framework_path}" unless resolved_framework_path == framework_path

unless target.frameworks_build_phase.files_references.include?(framework_reference)
  target.frameworks_build_phase.add_file_reference(framework_reference, true)
end

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
