// Builds an iOS configuration profile (.mobileconfig) that applies a proxy
// only while connected to a specific Wi-Fi network. This is the most a
// regular (non-supervised) iPhone allows — a true device-wide/global proxy
// requires MDM supervision, which personal iPhones don't have.

function xmlEscape(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateWifiProxyProfile({
  ssid,
  wifiPassword,      // omit/leave blank if the network is open
  proxyHost,
  proxyPort,
  proxyUsername,
  proxyPassword,
  displayName = "Proxy Config",
}) {
  const wifiPayloadUUID = crypto.randomUUID();
  const topLevelUUID = crypto.randomUUID();
  const isSecured = Boolean(wifiPassword);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.wifi.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.vpnbackend.wifi.${wifiPayloadUUID}</string>
      <key>PayloadUUID</key>
      <string>${wifiPayloadUUID}</string>
      <key>PayloadDisplayName</key>
      <string>${xmlEscape(ssid)} (proxied)</string>

      <key>SSID_STR</key>
      <string>${xmlEscape(ssid)}</string>
      <key>HIDDEN_NETWORK</key>
      <false/>
      <key>AutoJoin</key>
      <true/>
      <key>EncryptionType</key>
      <string>${isSecured ? "WPA2" : "None"}</string>
      ${isSecured ? `<key>Password</key>\n      <string>${xmlEscape(wifiPassword)}</string>` : ""}

      <key>ProxyType</key>
      <string>Manual</string>
      <key>ProxyServer</key>
      <string>${xmlEscape(proxyHost)}</string>
      <key>ProxyServerPort</key>
      <integer>${proxyPort}</integer>
      ${proxyUsername ? `<key>ProxyUsername</key>\n      <string>${xmlEscape(proxyUsername)}</string>` : ""}
      ${proxyPassword ? `<key>ProxyPassword</key>\n      <string>${xmlEscape(proxyPassword)}</string>` : ""}
    </dict>
  </array>

  <key>PayloadDisplayName</key>
  <string>${xmlEscape(displayName)}</string>
  <key>PayloadIdentifier</key>
  <string>com.vpnbackend.profile.${topLevelUUID}</string>
  <key>PayloadUUID</key>
  <string>${topLevelUUID}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>`;
}
