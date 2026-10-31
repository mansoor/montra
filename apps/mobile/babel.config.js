module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo includes expo-router and the Reanimated/worklets plugin.
    presets: ['babel-preset-expo'],
  };
};
