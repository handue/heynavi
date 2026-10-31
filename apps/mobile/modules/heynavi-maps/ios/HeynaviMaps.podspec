Pod::Spec.new do |s|
  s.name           = 'HeynaviMaps'
  s.version        = '1.0.0'
  s.summary        = 'Apple MapKit place search and walking routes for HeyNavi'
  s.description    = 'MKLocalSearch, MKDirections (walking) and reverse geocoding, on the phone.'
  s.author         = 'HeyNavi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'MapKit', 'CoreLocation'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,swift}"
end
