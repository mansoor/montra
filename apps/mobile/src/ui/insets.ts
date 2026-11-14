/**
 * The system bars a screen must keep clear of (Android draws edge to edge). A screen with a title bar needs no top
 * inset (the bar already sits below the status bar), and a tab's tab bar keeps it off the navigation bar; everything
 * else ends above it, so the last button isn't under Android's home and back buttons.
 */
export function screenInsets(
  segments: readonly string[],
  insets: { top: number; bottom: number },
): { top: number; bottom: number } {
  const inTabs = segments[0] === '(tabs)';
  const noTitleBar = inTabs || segments.length === 0 || segments[0] === 'sign-in';
  return { top: noTitleBar ? insets.top : 0, bottom: inTabs ? 0 : insets.bottom };
}
