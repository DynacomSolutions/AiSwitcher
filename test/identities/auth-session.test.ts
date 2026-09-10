import { describe, expect, test } from "bun:test";
import { AliAuthRefreshError, hasAliLoginCookie } from "../../src/identities/auth-session.ts";

describe("hasAliLoginCookie", () => {
  test("the live logged-OUT console (2026-09-10 fixture) has no login marker", () => {
    // Cookie names captured live from the chrome-auth-personal pod's Chrome
    // while the console page rendered "Log In to Use": analytics cookies and
    // the CSRF token exist WITHOUT authentication, so csrf must never count as
    // a login marker. Names only; values were never captured.
    const loggedOut = [
      "cna", "_bl_uid", "_uab_collina", "_ali_s_gray_v", "aliyun_intl_choice",
      "alicloud_deploy_r_s", "_alicloud_ab_trace_id", "_ali_s_gray_t", "_gcl_au",
      "account_info_switch", "_fbp", "_ga", "_umdata", "_uetvid",
      "last_u_intl-aliyun_intl-aliyun", "last_cc", "aliyun_country",
      "_ga_K73QREWZ1D", "aliyun_site", "aliyun_lang", "cnaui", "aui", "yunpk",
      "aliyun_choice", "g_state", "sca", "atpsida", "xlly_s", "isg", "tfstk",
      "JSESSIONID", "partitioned_cookie_flag", "login_aliyunid_csrf", "test_cookie",
    ].map((name) => ({ name }));
    expect(hasAliLoginCookie(loggedOut)).toBe(false);
  });

  test("the account ticket cookie proves authentication", () => {
    expect(hasAliLoginCookie([{ name: "cna" }, { name: "login_aliyunid_ticket" }])).toBe(true);
  });

  test("the account id cookie also proves authentication", () => {
    expect(hasAliLoginCookie([{ name: "login_aliyunid" }])).toBe(true);
  });

  test("missing names and empty input never authenticate", () => {
    expect(hasAliLoginCookie([{ name: undefined }, { name: "" }])).toBe(false);
    expect(hasAliLoginCookie([])).toBe(false);
  });

  test("harvested name=value header entries are recognised too", () => {
    expect(hasAliLoginCookie(["cna=abc", "login_aliyunid_ticket=ticket"])).toBe(true);
    expect(hasAliLoginCookie(["cna=abc", "login_aliyunid_csrf=token"])).toBe(false);
  });
});

describe("AliAuthRefreshError", () => {
  test("carries the remediation hint alongside the message", () => {
    const error = new AliAuthRefreshError("not signed in", "run 'ais auth login personal --tool=ali'");
    expect(error.name).toBe("AliAuthRefreshError");
    expect(error.message).toBe("not signed in");
    expect(error.hint).toBe("run 'ais auth login personal --tool=ali'");
    expect(error instanceof Error).toBe(true);
  });

  test("the hint is optional", () => {
    const error = new AliAuthRefreshError("harvest failed");
    expect(error.hint).toBeUndefined();
  });
});
