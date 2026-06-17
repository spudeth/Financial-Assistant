# Pending Fixes

## Native-code libraries blocked until we have an Apple Developer account

**Issue:** We can't use any library that contains native (Swift/Kotlin) code — for example `react-native-keyboard-controller`, which we installed once to fix keyboard animation jank, then had to fully revert. Plain ExpoGo only supports a fixed, pre-built set of native modules; anything outside that set requires building a custom version of the app.

**Why it's blocked:** Installing a custom build on a physical iPhone requires signing it with an Apple Developer Program account ($99/year) — this is an Apple requirement, not something Expo/EAS can work around. We're also on Windows with no Mac, so a Simulator-only build (which doesn't need the paid account) isn't usable here either. Note: this same $99/year account will be needed later for App Store submission anyway, so it's not wasted money — just a question of timing.

**Current workaround (already in place, works fine in ExpoGo):** the chat screen's keyboard handling (`app/(tabs)/chat.tsx`) was rebuilt using only core React Native APIs — listening to iOS's `keyboardWillShow`/`keyboardWillHide` events directly and animating with the exact `duration` iOS reports, instead of relying on a third-party library. No native code involved.

**Solution, once an Apple Developer account is obtained:**
1. `npx expo install expo-dev-client`
2. `npm install --save-dev eas-cli`
3. `npx eas login`, then `npx eas init` — link to the existing EAS project already connected to this GitHub repo (pick it from the interactive prompt)
4. `npx eas build:configure` — generates `eas.json` with development/preview/production profiles
5. `npx eas device:create` — register the test iPhone for ad-hoc builds
6. `npx eas build --profile development --platform ios` — first cloud build of a custom dev client (~15-20 min). EAS will offer to manage Apple signing credentials automatically.
7. Install the resulting build on the iPhone via the link/QR code EAS provides
8. From then on, run `npx expo start --dev-client` instead of `npx expo start`, and open the custom installed app instead of ExpoGo
9. Re-install `react-native-keyboard-controller` and swap it back into `chat.tsx` if still wanted (the JS-only workaround can stay too — both work)
10. Later, for App Store: `npx eas build --profile production --platform ios` then `npx eas submit -p ios`
