const api = typeof browser !== "undefined" ? browser : chrome;

const VIEWER_PATH = "dist/viewer.html";

api.action.onClicked.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL(VIEWER_PATH) });
});

// Register a single dynamic DNR rule that redirects any top-level navigation
// to a *.parquet URL (http/https/file) into the viewer. This works on both
// Chrome and Firefox MV3, including file:// URLs (provided the user has
// granted "Allow access to file URLs"). regexSubstitution can't URL-encode,
// so we put the original URL in the fragment as #url=<raw> and let the
// viewer parse that.
const dnr = api.declarativeNetRequest;
if (dnr && typeof dnr.updateDynamicRules === "function") {
  dnr
    .updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: "redirect",
            redirect: {
              regexSubstitution: api.runtime.getURL(VIEWER_PATH) + "#url=\\0",
            },
          },
          condition: {
            regexFilter:
              "^(?:https?|file)://[^#]*\\.parquet(\\?[^#]*)?(#.*)?$",
            resourceTypes: ["main_frame"],
          },
        },
      ],
    })
    .catch((e) => console.warn("DNR registration failed:", e));
}
