# -*- coding: utf-8 -*-
import ast
import json
import os
import re
import base64
import hashlib
import urllib.parse
import urllib.request
import webbrowser
import socket
import email.utils
import subprocess
import sys
import threading
import time
import datetime
import ctypes
import ctypes.wintypes
import psutil
import traceback
import shutil
import copy
import struct
import calendar
from difflib import SequenceMatcher
from pathlib import Path

import io
from PIL import Image, ImageDraw

import urllib.error



def is_packaged_app():
    try:
        if getattr(sys, "frozen", False):
            return True
        if getattr(sys.modules.get("__main__"), "__compiled__", None):
            return True
        if os.environ.get("NUITKA_ONEFILE_PARENT") or os.environ.get("NUITKA_ONEFILE_TEMP"):
            return True
        exe_name = Path(sys.argv[0]).name.lower()
        return exe_name.endswith(".exe") and "python" not in exe_name
    except Exception:
        return False


def early_app_dir():
    try:
        if is_packaged_app():
            return Path(sys.executable).resolve().parent
        return Path(__file__).resolve().parent
    except Exception:
        return Path.cwd()


EARLY_LOG_PATH = early_app_dir() / "TBH启动诊断.log"


def file_logging_enabled():
    if "--console" in sys.argv:
        return True
    try:
        return bool(getattr(sys.stdout, "isatty", lambda: False)())
    except Exception:
        return False


def early_log(text):
    if not file_logging_enabled():
        return
    try:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with EARLY_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {text}\n")
    except Exception:
        pass


try:
    import frida
except ModuleNotFoundError:
    frida = None




def enable_debug_console_if_requested():
    if "--console" not in sys.argv:
        return
    try:
        kernel32 = ctypes.windll.kernel32
        if not kernel32.GetConsoleWindow():
            if not kernel32.AttachConsole(-1):
                kernel32.AllocConsole()
        sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
        sys.stderr = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
        try:
            sys.stdin = open("CONIN$", "r", encoding="utf-8", errors="replace", buffering=1)
        except Exception:
            pass
        os.environ["PYTHONIOENCODING"] = "utf-8"
        print("调试控制台已开启", flush=True)
    except Exception:
        pass


def pause_debug_console_on_exit():
    if "--console" not in sys.argv:
        return
    try:
        input("程序已退出，按回车关闭控制台...")
    except Exception:
        try:
            os.system("pause")
        except Exception:
            pass


enable_debug_console_if_requested()
early_log("bootstrap start argv=" + " ".join(sys.argv))


class MarketPricePayloadError(Exception):
    pass


def is_windows_admin():
    if os.name != "nt":
        return True
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_as_admin_if_needed():
    if os.name != "nt" or is_windows_admin() or "--no-admin" in sys.argv:
        return False
    try:
        if is_packaged_app():
            exe = str(Path(sys.executable).resolve())
            args = [arg for arg in sys.argv[1:] if arg != "--elevated"] + ["--elevated"]
        else:
            exe = str(Path(sys.executable).resolve())
            args = [str(Path(__file__).resolve())] + [arg for arg in sys.argv[1:] if arg != "--elevated"] + ["--elevated"]
        params = subprocess.list2cmdline(args)
        rc = int(ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, str(APP_DIR), 1))
        if rc > 32:
            early_log("relaunch as admin requested")
            return True
        early_log(f"relaunch as admin cancelled or failed rc={rc}")
    except Exception:
        early_log("relaunch as admin failed:\n" + traceback.format_exc())
    return False


def resource_base_dir():
    candidates = []
    candidates.append(Path(__file__).resolve().parent)
    candidates.append(early_app_dir())
    for key in ("NUITKA_ONEFILE_PARENT", "NUITKA_ONEFILE_TEMP"):
        val = os.environ.get(key)
        if val:
            candidates.append(Path(val).resolve())
    compiled = getattr(sys.modules.get("__main__"), "__compiled__", None)
    if compiled:
        containing = getattr(compiled, "containing_dir", None)
        if containing:
            candidates.append(Path(containing).resolve())
    if is_packaged_app():
        candidates.append(Path(sys.argv[0]).resolve().parent)

    seen = set()
    unique = []
    for path in candidates:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path)

    for path in unique:
        if (path / "drop_items_info_v4_new2.js").exists() or (path / "drop_items_info_v4_new.js").exists() or (path / "drop_items_info_v4.js").exists():
            return path
    return unique[0]


PROCESS_NAME = "TaskbarHero.exe"
APP_VERSION = "1.0.5"
UPDATE_APP_NAME = "TBH掉落监控-观星祈祷"
UPDATE_API = "http://127.0.0.1/version"


def app_dir():
    if is_packaged_app():
        return Path(sys.argv[0]).resolve().parent
    return Path(__file__).resolve().parent


def resource_dir():
    return resource_base_dir()


APP_DIR = app_dir()
RESOURCE_DIR = resource_dir()
LOG_PATH = APP_DIR / "TBH掉落监控.log"
SCRIPT_PATH = RESOURCE_DIR / "drop_items_info_v4_new2.js"
CONFIG_PATH = APP_DIR / "drop_items_config.json"
DEFAULT_CONFIG_PATH = RESOURCE_DIR / "drop_items_config.json"
BOX_MATCH_THRESHOLD = 0.80
OCR_BASE_CAPTURE_WIDTH = 970.0
OCR_BASE_CAPTURE_HEIGHT = 892.0
OCR_BASE_NOTICE_RECT = (321.0, 679.0, 647.0, 728.0)
DEFAULT_NOTICE_RELATIVE_RECT = (
    OCR_BASE_NOTICE_RECT[0] / OCR_BASE_CAPTURE_WIDTH,
    OCR_BASE_NOTICE_RECT[1] / OCR_BASE_CAPTURE_HEIGHT,
    OCR_BASE_NOTICE_RECT[2] / OCR_BASE_CAPTURE_WIDTH,
    OCR_BASE_NOTICE_RECT[3] / OCR_BASE_CAPTURE_HEIGHT,
)
OCR_LIMIT_BASE_CAPTURE_WIDTH = 970.0
OCR_LIMIT_BASE_CAPTURE_HEIGHT = 892.0
OCR_LIMIT_NOTICE_RECT = (621.0, 434.0, 956.0, 523.0)
OCR_LIMIT_TEXT = "由于频繁切换关卡移动受到限制"
DEFAULT_BOX_SEARCH_ROI = (0.45, 0.78, 0.62, 0.86)
STEAM_MARKET_API_URL = "https://127.0.0.1/api/prices"
STEAM_MARKET_SOURCE_LABEL = "https://tbhindex.com/market"
STEAM_MARKET_REFRESH_SECONDS = 3600
MEMORY_TRIM_INTERVAL_SECONDS = 600
DEFAULT_MARKET_CURRENCY = "CNY"
ALL_MARKET_CURRENCY_CODES = ["CNY", "USD"]
STEAM_MARKET_KEYWORD_SOURCE_PATH = Path(__file__).resolve().parent.parent / "cs" / "post_steam_market_search.py"
MARKET_PRICE_CACHE_PATH = APP_DIR / "market_prices_cache.json"
STEAM_CURRENCY_SYMBOLS = {
    "CNY": "¥",
    "USD": "$",
}
FIXED_MARKET_RATES = {
    "BRL": 1.0,
    "CNY": 1.3128,
    "USD": 0.193196,
}
STEAM_GRADE_EN_TO_ZH = {
    "Common": "普通",
    "Uncommon": "罕见",
    "Rare": "稀有",
    "Legendary": "传奇",
    "Immortal": "不朽",
    "Arcana": "至宝",
    "Beyond": "超凡",
    "Celestial": "天界",
    "Divine": "神圣",
    "Cosmic": "宇宙",
}
STEAM_TYPE_EN_TO_ZH = {
    "Weapon": "武器",
    "Armor": "护甲",
    "Accessory": "饰品",
    "Material": "材料",
}
STEAM_TYPE_KEYWORDS = [
    ("Crossbow", "Weapon"),
    ("Sword", "Weapon"),
    ("Bow", "Weapon"),
    ("Hatchet", "Weapon"),
    ("Axe", "Weapon"),
    ("Staff", "Weapon"),
    ("Scepter", "Weapon"),
    ("Tome", "Weapon"),
    ("Orb", "Weapon"),
    ("Arrow", "Weapon"),
    ("Bolt", "Weapon"),
    ("Blade", "Weapon"),
    ("Rapier", "Weapon"),
    ("Cutlas", "Weapon"),
    ("Helmet", "Armor"),
    ("Armor", "Armor"),
    ("Gloves", "Armor"),
    ("Boots", "Armor"),
    ("Shield", "Armor"),
    ("Mail", "Armor"),
    ("Plate", "Armor"),
    ("Ring", "Accessory"),
    ("Amulet", "Accessory"),
    ("Earring", "Accessory"),
    ("Bracer", "Accessory"),
    ("Pendant", "Accessory"),
]
STEAM_ITEM_KEYWORDS_ZH = {
    "Dimensional Sword": "次元之剑",
    "Dimensional Boots": "次元靴",
    "Dimensional Scepter": "次元权杖",
    "Dimensional Armor": "次元铠甲",
    "Dimensional Gloves": "次元手套",
    "Dimensional Helmet": "次元头盔",
    "Dimensional Shield": "次元盾",
    "Dimensional Orb": "次元宝珠",
    "Dimensional Crossbow": "次元弩",
    "Dimensional Bow": "次元之弓",
    "Coral Piece": "珊瑚碎片",
    "Jade Stone": "翡翠玉石",
    "Amber Gem": "琥珀宝石",
    "Amethyst": "紫水晶",
    "Gold Ingot": "金锭",
    "Silver Ingot": "银锭",
    "Bronze Ingot": "青铜锭",
    "Iron Ingot": "铁锭",
    "Bloodstone": "血石",
    "Soulstone - Torment": "灵魂石 - 折磨",
    "Soulstone - Hell": "灵魂石 - 地狱",
    "Soulstone - Nightmare": "灵魂石 - 梦魇",
    "Soulstone - Normal": "灵魂石 - 普通",
    "Shadow Bow": "暗影之弓",
    "Shadow Orb": "暗影法球",
    "Shadow Scepter": "暗影权杖",
    "Shadow Shield": "暗影盾",
    "Shadow Tome": "暗影魔典",
    "Shadow Gloves": "暗影手套",
    "Shadow Helmet": "暗影头盔",
    "Shadow Hatchet": "暗影手斧",
    "Shadow Crossbow": "暗影弩",
    "Storm Staff": "暴风之杖",
    "Storm Sword": "暴风之剑",
    "Vengeance Sword": "复仇之剑",
    "Infinite Bow": "无限弓",
    "Infinite Scepter": "无限权杖",
    "Infinite Staff": "无限法杖",
    "Knight Boots": "骑士靴",
    "Kingdom 1st Anniversary Coin": "王国一周年纪念币",
    "Empire 1st Anniversary Coin": "帝国一周年纪念币",
    "Kingdom 10th Anniversary Coin": "王国十周年纪念币",
    "Empire 10th Anniversary Coin": "帝国十周年纪念币",
    "Kingdom 50th Anniversary Coin": "王国50周年纪念币",
    "Empire 50th Anniversary Coin": "帝国建国50周年纪念币",
    "Kingdom 100th Anniversary Coin": "王国百年纪念币",
    "Empire 100th Anniversary Coin": "帝国百年纪念币",
    "Holy Kingdom 1000th Anniversary Coin": "神圣王国1000周年纪念币",
    "Eternal Empire 1000th Anniversary Coin": "永恒帝国千年纪念硬币",
}


STEAM_ITEM_NAME_ALIASES_ZH = {
    "Tempest Staff": ["暴风之杖", "暴风法杖"],
    "Storm Staff": ["暴风之杖", "暴风法杖"],
}


def build_frida_network_probe_source():
    return r"""
'use strict';

var CFG = __CFG_JSON__;

function methodKey(ns, klass, name, argc) {
    return ns + '|' + klass + '|' + name + '|' + argc;
}

function api(name, ret, args) { return new NativeFunction(GA.getExportByName(name), ret, args); }

var GA = Process.enumerateModules().find(function(m) {
    return m.name.toLowerCase().indexOf('gameassembly') !== -1;
});
if (!GA) throw new Error('GameAssembly.dll not found');

var il2cpp_domain_get = api('il2cpp_domain_get', 'pointer', []);
var il2cpp_domain_get_assemblies = api('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
var il2cpp_assembly_get_image = api('il2cpp_assembly_get_image', 'pointer', ['pointer']);
var il2cpp_class_from_name = api('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
var il2cpp_class_get_method_from_name = api('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var il2cpp_string_new = api('il2cpp_string_new', 'pointer', ['pointer']);
var il2cpp_array_new = api('il2cpp_array_new', 'pointer', ['pointer', 'uint64']);

function cstr(s) { return Memory.allocUtf8String(s); }
function ptrText(p) { try { return p && !p.isNull() ? p.toString() : ''; } catch (e) { return ''; } }
function out(payload, data) { send(payload, data); }

function il2cppString(strObj) {
    try {
        if (!strObj || strObj.isNull()) return '';
        var len = strObj.add(0x10).readS32();
        if (len <= 0 || len > 65536) return '';
        return strObj.add(0x14).readUtf16String(len) || '';
    } catch (e) {
        return '';
    }
}

function byteArrayLength(arr) {
    try {
        if (!arr || arr.isNull()) return 0;
        var n = arr.add(0x18).readU32();
        if (n > 256 * 1024 * 1024) return 0;
        return n;
    } catch (e) {
        return 0;
    }
}

function byteArrayBytes(arr, maxBytes) {
    try {
        var n = byteArrayLength(arr);
        if (n <= 0) return null;
        var take = Math.min(n, Math.max(0, maxBytes || n));
        if (take <= 0) return null;
        return Memory.readByteArray(arr.add(0x20), take);
    } catch (e) {
        return null;
    }
}

var domain = il2cpp_domain_get();
var countPtr = Memory.alloc(4);
var assemblies = il2cpp_domain_get_assemblies(domain, countPtr);
var assemblyCount = countPtr.readU32();
var classCache = {};
var methodCache = {};

function findClass(ns, klassName) {
    var key = ns + '|' + klassName;
    if (classCache[key] !== undefined) return classCache[key];
    for (var i = 0; i < assemblyCount; i++) {
        var asm = assemblies.add(i * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var image = il2cpp_assembly_get_image(asm);
        if (!image || image.isNull()) continue;
        var klass = il2cpp_class_from_name(image, cstr(ns), cstr(klassName));
        if (klass && !klass.isNull()) {
            classCache[key] = klass;
            return klass;
        }
    }
    classCache[key] = ptr(0);
    return ptr(0);
}

function methodInfo(ns, klassName, methodName, argc) {
    var key = methodKey(ns, klassName, methodName, argc);
    if (methodCache[key] !== undefined) return methodCache[key];
    var klass = findClass(ns, klassName);
    if (!klass || klass.isNull()) {
        methodCache[key] = ptr(0);
        return ptr(0);
    }
    var method = il2cpp_class_get_method_from_name(klass, cstr(methodName), argc);
    methodCache[key] = method && !method.isNull() ? method : ptr(0);
    return methodCache[key];
}

function methodPtr(ns, klassName, methodName, argc) {
    var method = methodInfo(ns, klassName, methodName, argc);
    if (!method || method.isNull()) return ptr(0);
    try { return method.readPointer(); } catch (e) { return ptr(0); }
}

function makeFn(p, ret, args) {
    return p && !p.isNull() ? new NativeFunction(p, ret, args) : null;
}

var getUrl = makeFn(methodPtr('UnityEngine.Networking', 'UnityWebRequest', 'get_url', 0), 'pointer', ['pointer', 'pointer']);
var getMethod = makeFn(methodPtr('UnityEngine.Networking', 'UnityWebRequest', 'get_method', 0), 'pointer', ['pointer', 'pointer']);
var getUploadHandler = makeFn(methodPtr('UnityEngine.Networking', 'UnityWebRequest', 'get_uploadHandler', 0), 'pointer', ['pointer', 'pointer']);
var getDownloadHandler = makeFn(methodPtr('UnityEngine.Networking', 'UnityWebRequest', 'get_downloadHandler', 0), 'pointer', ['pointer', 'pointer']);
var uploadGetData = makeFn(methodPtr('UnityEngine.Networking', 'UploadHandler', 'get_data', 0), 'pointer', ['pointer', 'pointer']);
var downloadGetText = makeFn(methodPtr('UnityEngine.Networking', 'DownloadHandler', 'get_text', 0), 'pointer', ['pointer', 'pointer']);
var downloadGetData = makeFn(methodPtr('UnityEngine.Networking', 'DownloadHandler', 'get_data', 0), 'pointer', ['pointer', 'pointer']);

var getUrlInfo = methodInfo('UnityEngine.Networking', 'UnityWebRequest', 'get_url', 0);
var getMethodInfo = methodInfo('UnityEngine.Networking', 'UnityWebRequest', 'get_method', 0);
var getUploadHandlerInfo = methodInfo('UnityEngine.Networking', 'UnityWebRequest', 'get_uploadHandler', 0);
var getDownloadHandlerInfo = methodInfo('UnityEngine.Networking', 'UnityWebRequest', 'get_downloadHandler', 0);
var uploadGetDataInfo = methodInfo('UnityEngine.Networking', 'UploadHandler', 'get_data', 0);
var downloadGetTextInfo = methodInfo('UnityEngine.Networking', 'DownloadHandler', 'get_text', 0);
var downloadGetDataInfo = methodInfo('UnityEngine.Networking', 'DownloadHandler', 'get_data', 0);
var byteClass = findClass('System', 'Byte');

function reqUrl(req) {
    try { return getUrl && getUrlInfo && !getUrlInfo.isNull() ? il2cppString(getUrl(req, getUrlInfo)) : ''; } catch (e) { return ''; }
}

function reqMethod(req) {
    try { return getMethod && getMethodInfo && !getMethodInfo.isNull() ? il2cppString(getMethod(req, getMethodInfo)) : ''; } catch (e) { return ''; }
}

function reqUploadHandler(req) {
    try { return getUploadHandler && getUploadHandlerInfo && !getUploadHandlerInfo.isNull() ? getUploadHandler(req, getUploadHandlerInfo) : ptr(0); } catch (e) { return ptr(0); }
}

function reqDownloadHandler(req) {
    try { return getDownloadHandler && getDownloadHandlerInfo && !getDownloadHandlerInfo.isNull() ? getDownloadHandler(req, getDownloadHandlerInfo) : ptr(0); } catch (e) { return ptr(0); }
}

function uploadBytes(handler) {
    try {
        if (!handler || handler.isNull() || !uploadGetData || !uploadGetDataInfo || uploadGetDataInfo.isNull()) return null;
        var arr = uploadGetData(handler, uploadGetDataInfo);
        return byteArrayBytes(arr, CFG.maxBytes);
    } catch (e) {
        return null;
    }
}

function matchesUrl(url) {
    var needle = String(CFG.contains || '');
    if (!needle) return true;
    return String(url || '').indexOf(needle) >= 0;
}

function bytesToUtf8(bytes) {
    if (!bytes) return '';
    var arr = new Uint8Array(bytes);
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(arr);
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}

function utf8ToBytes(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text || ''));
    var utf8 = unescape(encodeURIComponent(String(text || '')));
    var arr = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i);
    return arr;
}

function newIl2cppString(text) {
    return il2cpp_string_new(Memory.allocUtf8String(String(text || '')));
}

function newByteArrayFromText(text) {
    if (!byteClass || byteClass.isNull()) return ptr(0);
    var bytes = utf8ToBytes(text);
    var arr = il2cpp_array_new(byteClass, bytes.length);
    if (!arr || arr.isNull()) return ptr(0);
    if (bytes.length > 0) Memory.writeByteArray(arr.add(0x20), bytes);
    return arr;
}

function detectStageFromRequestText(text) {
    try {
        if (!text) return { stage: '', itemIds: [] };
        var reqJson = JSON.parse(text);
        var reqBody = (((reqJson || {}).functionBody || {}).body || {});
        var action = String(reqBody.action || '').trim();
        if (action !== 'processBox' && action !== 'processBoxV2') return { stage: '', itemIds: [] };
        var rawList = reqBody.createItemList || '[]';
        var items = typeof rawList === 'string' ? JSON.parse(rawList) : rawList;
        var ids = [];
        var maxLevel = 0;
        for (var i = 0; i < (items || []).length; i++) {
            var it = items[i] || {};
            if (!it.itemId) continue;
            ids.push(it.itemId);
            var sid = String(it.itemId).replace(/\D+/g, '');
            if (sid.length < 3) continue;
            var suffix = parseInt(sid.slice(-3), 10);
            if (!(suffix >= 10 && suffix % 10 === 1)) continue;
            var level = Math.floor(suffix / 10);
            if (level > maxLevel) maxLevel = level;
        }
        return { stage: maxLevel > 0 ? ('LV' + maxLevel) : '', itemIds: ids };
    } catch (e) {
        return { stage: '', itemIds: [] };
    }
}

var nextId = 1;
var requestByPtr = {};
var requestByDownloadHandler = {};
var recentResponses = {};
var rewriteIndices = {};
var rewriteCache = {};

function cleanupRewriteCache() {
    var now = Date.now();
    Object.keys(rewriteCache).forEach(function(key) {
        var row = rewriteCache[key];
        if (!row || now - (row.at || 0) > 30000) delete rewriteCache[key];
    });
}

function cloneRewriteLists() {
    var src = CFG.rewriteLists || {};
    var dst = {};
    Object.keys(src).forEach(function(key) {
        if (Array.isArray(src[key]) && src[key].length > 0) dst[key] = src[key].slice();
    });
    return dst;
}

function rewriteResponseText(originalText, cacheKey, info) {
    cleanupRewriteCache();
    if (!CFG.rewriteEnabled || !originalText) {
        return { text: originalText, modified: 0, queues: [] };
    }
    if (cacheKey && rewriteCache[cacheKey]) {
        return rewriteCache[cacheKey].result;
    }
    var rewriteLists = CFG.rewriteLists || {};
    try {
        var outer = JSON.parse(originalText);
        var resultIsString = typeof outer.result === 'string';
        var data = resultIsString ? JSON.parse(outer.result) : outer;
        var boxes = (((data || {}).data || {}).boxes || []);
        if (!Array.isArray(boxes) || boxes.length <= 0) {
            return { text: originalText, modified: 0, queues: [] };
        }
        var modified = 0;
        var touchedQueues = [];
        for (var i = 0; i < boxes.length; i++) {
            var box = boxes[i];
            if (!box || typeof box !== 'object') continue;
            var queueId = String(box.itemId || '').trim();
            var pool = rewriteLists[queueId];
            if (!Array.isArray(pool) || pool.length <= 0) continue;
            var index = rewriteIndices[queueId] || 0;
            var nextId = parseInt(pool[index], 10);
            if (!isFinite(nextId) || nextId <= 0) continue;
            box.rewardItemId = nextId;
            rewriteIndices[queueId] = (index + 1) % pool.length;
            modified += 1;
            if (touchedQueues.indexOf(queueId) < 0) touchedQueues.push(queueId);
        }
        if (modified <= 0) {
            return { text: originalText, modified: 0, queues: [] };
        }
        var rewritten = resultIsString
            ? JSON.stringify(Object.assign({}, outer, { result: JSON.stringify(data) }))
            : JSON.stringify(data);
        var result = {
            text: rewritten,
            modified: modified,
            queues: touchedQueues,
            stage: info && info.stage ? info.stage : ''
        };
        if (cacheKey) rewriteCache[cacheKey] = { at: Date.now(), result: result };
        out({
            kind: 'rewrite_applied',
            id: info && info.id ? info.id : '?',
            stage: info && info.stage ? info.stage : '',
            queues: touchedQueues,
            modified: modified
        });
        return result;
    } catch (e) {
        return { text: originalText, modified: 0, queues: [], error: String(e) };
    }
}

var sendWebRequestPtr = methodPtr('UnityEngine.Networking', 'UnityWebRequest', 'SendWebRequest', 0);
if (sendWebRequestPtr && !sendWebRequestPtr.isNull()) {
    Interceptor.attach(sendWebRequestPtr, {
        onEnter: function(args) {
            var req = args[0];
            var reqKey = ptrText(req);
            var url = reqUrl(req);
            if (!matchesUrl(url)) return;
            var method = reqMethod(req);
            var upload = reqUploadHandler(req);
            var download = reqDownloadHandler(req);
            var info = {
                id: nextId++,
                requestPtr: reqKey,
                downloadHandlerPtr: ptrText(download),
                method: method,
                url: url,
                stage: ''
            };
            requestByPtr[reqKey] = info;
            if (download && !download.isNull()) requestByDownloadHandler[ptrText(download)] = info;
            var bytes = uploadBytes(upload);
            if (bytes) {
                try {
                    var text = bytesToUtf8(bytes);
                    var stageInfo = detectStageFromRequestText(text);
                    if (stageInfo.stage) {
                        info.stage = stageInfo.stage;
                        out({
                            kind: 'stage_request',
                            id: info.id,
                            method: method,
                            url: url,
                            stage: stageInfo.stage,
                            itemIds: stageInfo.itemIds
                        });
                    }
                } catch (e) {}
            }
        }
    });
}

function responseInfoForHandler(handler) {
    var key = ptrText(handler);
    return requestByDownloadHandler[key] || {
        id: '?',
        method: '',
        url: '',
        stage: '',
        requestPtr: '',
        downloadHandlerPtr: key
    };
}

function maybeSendResponse(handler, source, text, arr) {
    var info = responseInfoForHandler(handler);
    if (!matchesUrl(info.url)) return;
    var key = ptrText(handler) + '|' + source + '|' + String(text || '').length + '|' + byteArrayLength(arr || ptr(0));
    var now = Date.now();
    if (recentResponses[key] && now - recentResponses[key] < 500) return;
    recentResponses[key] = now;
    var cacheKey = (info.id ? String(info.id) : ptrText(handler)) || ptrText(handler);
    if (text) {
        var rewrittenTextResult = rewriteResponseText(text, cacheKey, info);
        out({
            kind: 'process_box_response',
            id: info.id,
            source: source,
            requestPtr: info.requestPtr || '',
            downloadHandlerPtr: ptrText(handler),
            method: info.method || '',
            url: info.url || '',
            text: rewrittenTextResult.text || text,
            stage: info.stage || ''
        });
        return rewrittenTextResult;
    }
    var bytes = byteArrayBytes(arr, CFG.maxBytes);
    if (!bytes) return { text: '', modified: 0, queues: [] };
    try {
        var dataText = bytesToUtf8(bytes);
        var rewrittenDataResult = rewriteResponseText(dataText, cacheKey, info);
        out({
            kind: 'process_box_response',
            id: info.id,
            source: source,
            requestPtr: info.requestPtr || '',
            downloadHandlerPtr: ptrText(handler),
            method: info.method || '',
            url: info.url || '',
            text: rewrittenDataResult.text || dataText,
            stage: info.stage || ''
        });
        return rewrittenDataResult;
    } catch (e) {
        return { text: '', modified: 0, queues: [], error: String(e) };
    }
}

var downloadTextPtr = methodPtr('UnityEngine.Networking', 'DownloadHandler', 'get_text', 0);
if (downloadTextPtr && !downloadTextPtr.isNull()) {
    Interceptor.attach(downloadTextPtr, {
        onEnter: function(args) {
            this.handler = args[0];
        },
        onLeave: function(retval) {
            var text = il2cppString(retval);
            var result = maybeSendResponse(this.handler, 'get_text', text, ptr(0));
            if (result && result.modified > 0 && result.text) {
                var newStr = newIl2cppString(result.text);
                if (newStr && !newStr.isNull()) retval.replace(newStr);
            }
        }
    });
}

var downloadDataPtr = methodPtr('UnityEngine.Networking', 'DownloadHandler', 'get_data', 0);
if (downloadDataPtr && !downloadDataPtr.isNull()) {
    Interceptor.attach(downloadDataPtr, {
        onEnter: function(args) {
            this.handler = args[0];
        },
        onLeave: function(retval) {
            var result = maybeSendResponse(this.handler, 'get_data', '', retval);
            if (result && result.modified > 0 && result.text) {
                var newArr = newByteArrayFromText(result.text);
                if (newArr && !newArr.isNull()) retval.replace(newArr);
            }
        }
    });
}
"""


def write_debug_log(text):
    text = str(text)
    early_log(text)
    try:
        print(text, flush=True)
    except Exception:
        pass


def write_crash_log(text):
    early_log(str(text))


def notice_rect_for_image(image):
    if not isinstance(image, dict):
        return None
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    sx = width / OCR_BASE_CAPTURE_WIDTH
    sy = height / OCR_BASE_CAPTURE_HEIGHT
    scale = max(0.5, min(3.0, (sx + sy) / 2.0))
    left = int(round(OCR_BASE_NOTICE_RECT[0] * scale))
    top = int(round(OCR_BASE_NOTICE_RECT[1] * scale))
    right = int(round(OCR_BASE_NOTICE_RECT[2] * scale))
    bottom = int(round(OCR_BASE_NOTICE_RECT[3] * scale))
    left = max(0, min(left, width - 1))
    top = max(0, min(top, height - 1))
    right = max(left + 1, min(right, width))
    bottom = max(top + 1, min(bottom, height))
    return left, top, right, bottom


def relative_notice_rect_for_image(image, relative_rect=None):
    if not isinstance(image, dict):
        return None
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    rel = relative_rect or DEFAULT_NOTICE_RELATIVE_RECT
    try:
        left = int(round(float(rel[0]) * width))
        top = int(round(float(rel[1]) * height))
        right = int(round(float(rel[2]) * width))
        bottom = int(round(float(rel[3]) * height))
    except Exception:
        return None
    left = max(0, min(left, width - 1))
    top = max(0, min(top, height - 1))
    right = max(left + 1, min(right, width))
    bottom = max(top + 1, min(bottom, height))
    return left, top, right, bottom


def limit_notice_rect_for_image(image):
    if not isinstance(image, dict):
        return None
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    sx = width / OCR_LIMIT_BASE_CAPTURE_WIDTH
    sy = height / OCR_LIMIT_BASE_CAPTURE_HEIGHT
    scale = max(0.5, min(3.0, (sx + sy) / 2.0))
    left = int(round(OCR_LIMIT_NOTICE_RECT[0] * scale))
    top = int(round(OCR_LIMIT_NOTICE_RECT[1] * scale))
    right = int(round(OCR_LIMIT_NOTICE_RECT[2] * scale))
    bottom = int(round(OCR_LIMIT_NOTICE_RECT[3] * scale))
    left = max(0, min(left, width - 1))
    top = max(0, min(top, height - 1))
    right = max(left + 1, min(right, width))
    bottom = max(top + 1, min(bottom, height))
    return left, top, right, bottom


def is_limit_notice_text(text):
    compact = "".join(str(text or "").split())
    if not compact:
        return False
    if OCR_LIMIT_TEXT in compact:
        return True
    has_prefix = ("由于频繁切" in compact) or ("频繁切关卡" in compact) or ("频繁切换关卡" in compact)
    has_limit = ("移动受到限制" in compact) or ("受到限制" in compact)
    return has_prefix and has_limit


def crop_bgra_image(image, rect):
    if not isinstance(image, dict) or not rect:
        return None
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    channels = int(image.get("channels") or 0)
    if width <= 0 or height <= 0 or channels != 4:
        return None
    raw = base64.b64decode(str(image.get("data") or ""), validate=False)
    expected = width * height * channels
    if len(raw) < expected:
        return None
    left, top, right, bottom = rect
    crop_width = max(1, right - left)
    crop_height = max(1, bottom - top)
    stride = width * channels
    crop_rows = bytearray()
    for row in range(top, bottom):
        start = row * stride + left * channels
        end = start + crop_width * channels
        crop_rows.extend(raw[start:end])
    return {
        "width": crop_width,
        "height": crop_height,
        "channels": channels,
        "data": base64.b64encode(bytes(crop_rows)).decode("ascii"),
    }


def notice_time_rect_for_crop(image):
    if not isinstance(image, dict):
        return None
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    left = max(0, min(width - 1, int(round(width * 0.62))))
    top = 0
    right = width
    bottom = height
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def parse_version_tuple(value):
    parts = re.findall(r"\d+", str(value or ""))
    nums = [int(x) for x in parts[:4]]
    while len(nums) < 4:
        nums.append(0)
    return tuple(nums)


def http_request(url, data=None, headers=None, timeout=15, method=None):
    body = None
    if data is not None:
        if isinstance(data, dict):
            body = urllib.parse.urlencode(data).encode("utf-8")
        elif isinstance(data, str):
            body = data.encode("utf-8")
        else:
            body = data
    req_headers = dict(headers or {})
    req_headers.setdefault("Connection", "close")
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        return resp.read(), resp.geturl(), resp.headers


def http_text(url, data=None, headers=None, timeout=15):
    raw, final_url, resp_headers = http_request(url, data=data, headers=headers, timeout=timeout)
    try:
        return raw.decode("utf-8"), final_url
    except UnicodeDecodeError:
        charset = resp_headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace"), final_url


def load_market_keyword_map_from_source():
    try:
        source = STEAM_MARKET_KEYWORD_SOURCE_PATH.read_text(encoding="utf-8")
    except Exception:
        return {}
    match = re.search(r"ITEM_KEYWORDS_ZH\s*=\s*\{", source)
    if not match:
        return {}
    start = match.end() - 1
    depth = 0
    end = None
    for index, ch in enumerate(source[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        return {}
    try:
        parsed = ast.literal_eval(source[start:end])
    except Exception:
        return {}
    return {str(k): str(v) for k, v in dict(parsed or {}).items()}


STEAM_ITEM_KEYWORDS_ZH.update(load_market_keyword_map_from_source())


def visible_window_pids():
    pids = set()
    user32 = ctypes.windll.user32

    enum_proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                pids.add(int(pid.value))
        return True

    user32.EnumWindows(enum_proc_type(callback), 0)
    return pids


def focus_process_window(pid):
    user32 = ctypes.windll.user32
    enum_proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    target = {"hwnd": None}

    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            found_pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(found_pid))
            if int(found_pid.value or 0) == int(pid):
                target["hwnd"] = hwnd
                return False
        return True

    user32.EnumWindows(enum_proc_type(callback), 0)
    hwnd = target.get("hwnd")
    if hwnd:
        user32.ShowWindow(hwnd, 5)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.05)
    return hwnd


def hwnds_for_pid(pid):
    user32 = ctypes.windll.user32
    enum_proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    hwnds = []

    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            found_pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(found_pid))
            if int(found_pid.value or 0) == int(pid):
                hwnds.append(hwnd)
        return True

    user32.EnumWindows(enum_proc_type(callback), 0)
    return hwnds


def post_space_to_process(pid):
    user32 = ctypes.windll.user32
    hwnds = hwnds_for_pid(pid)
    if not hwnds:
        return False, []
    WM_KEYDOWN = 0x0100
    WM_CHAR = 0x0102
    WM_KEYUP = 0x0101
    VK_SPACE = 0x20
    scan = 0x39
    lparam_down = 1 | (scan << 16)
    lparam_up = 1 | (scan << 16) | (1 << 30) | (1 << 31)
    ok = False
    sent = []
    for hwnd in hwnds:
        if user32.PostMessageW(hwnd, WM_KEYDOWN, VK_SPACE, lparam_down):
            ok = True
            sent.append(int(hwnd))
        user32.PostMessageW(hwnd, WM_CHAR, VK_SPACE, lparam_down)
        time.sleep(0.03)
        user32.PostMessageW(hwnd, WM_KEYUP, VK_SPACE, lparam_up)
    return ok, sent


def post_space_to_processes(pids):
    sent_all = []
    ok_any = False
    for pid in pids:
        ok, sent = post_space_to_process(pid)
        if ok:
            ok_any = True
            sent_all.extend([(pid, hwnd) for hwnd in sent])
    return ok_any, sent_all


def win32_click_screen(x, y):
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    user32 = ctypes.windll.user32
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.03)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.03)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.02)
    user32.SetCursorPos(pt.x, pt.y)


def get_foreground_window():
    try:
        return int(ctypes.windll.user32.GetForegroundWindow() or 0)
    except Exception:
        return 0


def restore_foreground_window(hwnd):
    try:
        if hwnd:
            ctypes.windll.user32.SetForegroundWindow(int(hwnd))
    except Exception:
        pass


def pid_for_hwnd(hwnd):
    try:
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(ctypes.wintypes.HWND(int(hwnd)), ctypes.byref(pid))
        return int(pid.value or 0)
    except Exception:
        return 0


def activate_window_force(hwnd):
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    if not hwnd:
        return False
    try:
        hwnd = int(hwnd)
        SW_RESTORE = 9
        HWND_TOPMOST = -1
        HWND_NOTOPMOST = -2
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_SHOWWINDOW = 0x0040

        fg = int(user32.GetForegroundWindow() or 0)
        current_thread = int(kernel32.GetCurrentThreadId() or 0)
        fg_thread = int(user32.GetWindowThreadProcessId(fg, None) or 0) if fg else 0
        target_thread = int(user32.GetWindowThreadProcessId(hwnd, None) or 0)

        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.BringWindowToTop(hwnd)
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)

        attached_fg = False
        attached_target = False
        try:
            if fg_thread and fg_thread != current_thread:
                attached_fg = bool(user32.AttachThreadInput(current_thread, fg_thread, True))
            if target_thread and target_thread != current_thread:
                attached_target = bool(user32.AttachThreadInput(current_thread, target_thread, True))
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SetFocus(hwnd)
        finally:
            if attached_target:
                user32.AttachThreadInput(current_thread, target_thread, False)
            if attached_fg:
                user32.AttachThreadInput(current_thread, fg_thread, False)
        time.sleep(0.08)
        return int(user32.GetForegroundWindow() or 0) == hwnd
    except Exception:
        return False


def window_rect(hwnd):
    rect = ctypes.wintypes.RECT()
    if not ctypes.windll.user32.GetWindowRect(ctypes.wintypes.HWND(hwnd), ctypes.byref(rect)):
        return None
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def print_window_capture(hwnd):
    rect = window_rect(hwnd)
    if not rect:
        return None
    left, top, right, bottom = rect
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        return None
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    hdc_window = user32.GetWindowDC(ctypes.wintypes.HWND(hwnd))
    if not hdc_window:
        return None
    hdc_mem = gdi32.CreateCompatibleDC(hdc_window)
    if not hdc_mem:
        user32.ReleaseDC(ctypes.wintypes.HWND(hwnd), hdc_window)
        return None

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.wintypes.DWORD),
            ("biWidth", ctypes.wintypes.LONG),
            ("biHeight", ctypes.wintypes.LONG),
            ("biPlanes", ctypes.wintypes.WORD),
            ("biBitCount", ctypes.wintypes.WORD),
            ("biCompression", ctypes.wintypes.DWORD),
            ("biSizeImage", ctypes.wintypes.DWORD),
            ("biXPelsPerMeter", ctypes.wintypes.LONG),
            ("biYPelsPerMeter", ctypes.wintypes.LONG),
            ("biClrUsed", ctypes.wintypes.DWORD),
            ("biClrImportant", ctypes.wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.wintypes.DWORD * 3)]

    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = width
    bmi.bmiHeader.biHeight = -height
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0

    bits = ctypes.c_void_p()
    hbitmap = gdi32.CreateDIBSection(hdc_window, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    if not hbitmap:
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(ctypes.wintypes.HWND(hwnd), hdc_window)
        return None
    old_obj = gdi32.SelectObject(hdc_mem, hbitmap)
    try:
        ok = user32.PrintWindow(ctypes.wintypes.HWND(hwnd), hdc_mem, 2)
        if not ok:
            ok = user32.PrintWindow(ctypes.wintypes.HWND(hwnd), hdc_mem, 0)
        if not ok:
            return None
        raw = ctypes.string_at(bits, width * height * 4)
        return {
            "width": int(width),
            "height": int(height),
            "channels": 4,
            "data": base64.b64encode(raw).decode("ascii"),
        }
    finally:
        gdi32.SelectObject(hdc_mem, old_obj)
        gdi32.DeleteObject(hbitmap)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(ctypes.wintypes.HWND(hwnd), hdc_window)


def save_bgra_bmp(image, path):
    if not isinstance(image, dict):
        return False
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    channels = int(image.get("channels") or 0)
    if width <= 0 or height <= 0 or channels != 4:
        return False
    raw = base64.b64decode(str(image.get("data") or ""), validate=False)
    expected = width * height * channels
    if len(raw) < expected:
        return False
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    file_size = 14 + 40 + expected
    bmp_file_header = struct.pack(
        "<2sIHHI",
        b"BM",
        file_size,
        0,
        0,
        14 + 40,
    )
    bmp_info_header = struct.pack(
        "<IIIHHIIIIII",
        40,
        width,
        height,
        1,
        32,
        0,
        expected,
        0,
        0,
        0,
        0,
    )
    bottom_up = bytearray()
    stride = width * channels
    for row in range(height - 1, -1, -1):
        start = row * stride
        bottom_up.extend(raw[start:start + stride])
    path.write_bytes(bmp_file_header + bmp_info_header + bytes(bottom_up))
    return True


def save_bgra_png(image, path):
    try:
        from PIL import Image
        raw, width, height, channels = bgra_image_to_bgra_bytes(image)
        if raw is None or channels != 4:
            return False
        rgba = bytearray()
        for i in range(0, len(raw), 4):
            b = raw[i]
            g = raw[i + 1]
            r = raw[i + 2]
            a = raw[i + 3]
            rgba.extend((r, g, b, a))
        img = Image.frombytes("RGBA", (width, height), bytes(rgba))
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(path, format="PNG")
        return True
    except Exception:
        return False


def bgra_image_to_png_data_url(image):
    if not isinstance(image, dict):
        return ""
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    channels = int(image.get("channels") or 0)
    if width <= 0 or height <= 0 or channels != 4:
        return ""
    raw = base64.b64decode(str(image.get("data") or ""), validate=False)
    expected = width * height * channels
    if len(raw) < expected:
        return ""
    try:
        rgba = bytearray()
        for i in range(0, expected, 4):
            b = raw[i]
            g = raw[i + 1]
            r = raw[i + 2]
            a = raw[i + 3]
            rgba.extend((r, g, b, a))
        img = Image.frombytes("RGBA", (width, height), bytes(rgba))
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:
        return ""


def make_preview_image(image, max_width=960):
    if not isinstance(image, dict):
        return None, 1.0
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    channels = int(image.get("channels") or 0)
    if width <= 0 or height <= 0 or channels != 4:
        return None, 1.0
    raw = base64.b64decode(str(image.get("data") or ""), validate=False)
    expected = width * height * channels
    if len(raw) < expected:
        return None, 1.0
    try:
        rgba = bytearray()
        for i in range(0, expected, 4):
            b = raw[i]
            g = raw[i + 1]
            r = raw[i + 2]
            a = raw[i + 3]
            rgba.extend((r, g, b, a))
        image_rgba = Image.frombytes("RGBA", (width, height), bytes(rgba))
        scale = 1.0
        if width > max_width:
            scale = max_width / float(width)
            preview = image_rgba.resize((int(round(width * scale)), int(round(height * scale))), Image.Resampling.LANCZOS)
        else:
            preview = image_rgba
        preview_rgba = preview.tobytes()
        preview_bgra = bytearray()
        for i in range(0, len(preview_rgba), 4):
            r = preview_rgba[i]
            g = preview_rgba[i + 1]
            b = preview_rgba[i + 2]
            a = preview_rgba[i + 3]
            preview_bgra.extend((b, g, r, a))
        return {
            "width": int(preview.size[0]),
            "height": int(preview.size[1]),
            "channels": 4,
            "data": base64.b64encode(bytes(preview_bgra)).decode("ascii"),
        }, float(scale)
    except Exception:
        return None, 1.0


def bgra_image_to_bgra_bytes(image):
    if not isinstance(image, dict):
        return None, 0, 0, 0
    width = int(image.get("width") or 0)
    height = int(image.get("height") or 0)
    channels = int(image.get("channels") or 0)
    if width <= 0 or height <= 0 or channels != 4:
        return None, 0, 0, 0
    raw = base64.b64decode(str(image.get("data") or ""), validate=False)
    expected = width * height * channels
    if len(raw) < expected:
        return None, 0, 0, 0
    return raw[:expected], width, height, channels


def draw_match_rect_on_bgra_image(image, rect, output_path, color=(0, 255, 0, 255), thickness=2):
    raw, width, height, channels = bgra_image_to_bgra_bytes(image)
    if raw is None or channels != 4:
        return False
    try:
        left, top, rect_w, rect_h = [int(v) for v in (rect or [0, 0, 0, 0])]
        if rect_w <= 0 or rect_h <= 0:
            return False
        right = max(left + 1, left + rect_w)
        bottom = max(top + 1, top + rect_h)
        left = max(0, min(left, width - 1))
        top = max(0, min(top, height - 1))
        right = max(left + 1, min(right, width))
        bottom = max(top + 1, min(bottom, height))
        rgba = bytearray()
        for i in range(0, len(raw), 4):
            b = raw[i]
            g = raw[i + 1]
            r = raw[i + 2]
            a = raw[i + 3]
            rgba.extend((r, g, b, a))
        canvas = Image.frombytes("RGBA", (width, height), bytes(rgba))
        draw = ImageDraw.Draw(canvas)
        outline = (int(color[2]), int(color[1]), int(color[0]), int(color[3] if len(color) > 3 else 255))
        for offset in range(max(1, int(thickness))):
            draw.rectangle(
                (
                    left + offset,
                    top + offset,
                    max(left + offset, right - 1 - offset),
                    max(top + offset, bottom - 1 - offset),
                ),
                outline=outline,
            )
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        canvas.convert("RGB").save(path, format="BMP")
        return True
    except Exception:
        return False


def preview_capture_name(kind, capture_id=""):
    prefix = "boss_preview" if str(kind) == "boss" else "normal_preview"
    suffix = f"_{str(capture_id).strip()}" if str(capture_id).strip() else ""
    return f"{prefix}{suffix}.png"


DEFAULT_UMI_HTTP_URL = os.environ.get("TBH_UMI_HTTP_URL", "http://127.0.0.1:1224").strip() or "http://127.0.0.1:1224"


class JadeApi:
    def __init__(self, backend):
        self.window_id = 0
        self.base_url = ""
        self.shutdown = None
        self.backend = backend

    def handle(self, channel, window_id, payload):
        try:
            if channel in ("attach", "detach"):
                write_debug_log(f"IPC {channel} window={window_id}")
            try:
                data = json.loads(payload) if payload else {}
            except Exception:
                data = {}
            if channel == "windowAction":
                action = data.get("action", "")
                return self.window_action(action)
            if channel == "shutdownAndClose":
                return self.shutdown_and_close()
            if channel == "uiReady":
                return self.show_window_after_ready()
            if channel == "notify":
                return self.show_windows_notification(data)
            if channel == "checkUpdate":
                return self.check_update()
            if channel == "startUpdate":
                return self.start_update(data)
            if channel == "quickState":
                self.backend.ensure_game_process_alive()
                return self.backend.quick_state()
            if channel == "getState":
                self.backend.ensure_game_process_alive()
                return self.backend.response(True, "", include_script_status=False)
            if channel == "getMarketPrices":
                return self.backend.market_prices_response(data)
            if channel == "recordStatus":
                return self.backend.record_status_response()
            if channel == "attach":
                return self.backend.attach()
            if channel == "detach":
                return self.backend.detach()
            if channel == "applyConfig":
                return self.backend.apply_config(data)
            if channel == "applyRewriteEnabled":
                return self.backend.apply_rewrite_enabled(data)
            if channel == "setMarketCurrency":
                return self.backend.set_market_currency(data)
            if channel == "recordButton":
                return self.backend.record_button(data.get("index", -1))
            if channel == "clearRecordButton":
                return self.backend.clear_record_button(data.get("index", -1))
            if channel == "testBoxTemplate":
                return self.backend.test_box_template(
                    data.get("kind", "normal"),
                    data.get("normalTemplatePath", ""),
                    data.get("bossTemplatePath", ""),
                )
            if channel == "testNoticeRect":
                return self.backend.test_notice_rect()
            if channel == "chooseBoxTemplate":
                return self.choose_box_template(data)
            if channel == "captureBoxTemplate":
                return self.backend.capture_box_template(data.get("kind", "normal"))
            if channel == "saveBoxTemplateCapture":
                return self.backend.save_box_template_capture(
                    data.get("kind", "normal"),
                    data.get("captureId", ""),
                    data.get("rect"),
                )
            if channel in ["ready", "start", "stop", "startcross", "stopcross", "status", "clear"]:
                return self.backend.rpc(channel)
            return self.backend.response(False, "未知操作：" + str(channel))
        except Exception:
            detail = traceback.format_exc()
            write_crash_log(f"IPC回调异常 channel={channel} payload={payload}\n{detail}")
            try:
                return self.backend.response(False, f"操作失败（{channel}）：{detail.splitlines()[-1] if detail else '未知错误'}")
            except Exception:
                suffix = "，详情见 TBH启动诊断.log" if file_logging_enabled() else ""
                return {"ok": False, "message": f"操作失败（{channel}）{suffix}"}

    def show_window_after_ready(self):
        if not self.window_id:
            return {"ok": False, "message": "窗口尚未初始化"}
        try:
            from jadeview import window
            window.set_window_visible(self.window_id, True)
            window.set_window_focus(self.window_id)
            return {"ok": True, "message": "界面已加载完成"}
        except Exception as exc:
            return {"ok": False, "message": "显示窗口失败：" + str(exc)}

    def show_windows_notification(self, data):
        title = str(data.get("title") or "监控物品出现")
        body = str(data.get("body") or "")
        try:
            from jadeview import notification
            ok = notification.show_notification(title, body=body, timeout=6)
            return {"ok": bool(ok), "message": "Windows系统通知已发送" if ok else "Windows系统通知发送失败"}
        except Exception as exc:
            return {"ok": False, "message": "Windows系统通知失败：" + str(exc)}

    def check_update(self):
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.601.400 QQBrowser/20.0.7091.400",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "application/json, text/javascript, */*; q=0.01",
            }
            started = time.perf_counter()
            text, _ = http_text(UPDATE_API, data={"name": UPDATE_APP_NAME}, headers=headers, timeout=3)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            print(f"[更新] 检查版本耗时 {elapsed_ms}ms", flush=True)
            info = json.loads(text)
            latest = str(info.get("version") or "").strip()
            if not latest:
                return {"ok": False, "message": "检查更新失败：未找到版本号"}
            has_update = parse_version_tuple(latest) > parse_version_tuple(APP_VERSION)
            info["currentVersion"] = APP_VERSION
            notice = str(info.get("data") or "").strip()
            return {
                "ok": True,
                "message": "发现新版本" if has_update else "当前已是最新版本",
                "hasUpdate": has_update,
                "notice": notice,
                "update": info,
            }
        except Exception as exc:
            return {"ok": False, "message": "检查更新失败：" + sunny_error_cn(exc)}

    def is_direct_download_url(self, url):
        parsed = urllib.parse.urlparse(str(url or ""))
        path = parsed.path.lower()
        return path.endswith((".exe", ".zip", ".7z", ".rar", ".msi"))

    def resolve_download_url(self, url, pwd=""):
        url = str(url or "").strip()
        if not url:
            raise RuntimeError("更新地址为空")
        if not self.is_direct_download_url(url):
            return ""
        if "lanzou" not in url.lower():
            return url
        parsed = urllib.parse.urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        api_url = "https://api.txttool.cn/netcut/lanzou/"
        try:
            text, _ = http_text(api_url, data={"url": base, "pwd": pwd}, timeout=18)
            data = json.loads(text)
            down_url = data.get("downUrl") or data.get("url") or ((data.get("data") or {}).get("downUrl"))
            if down_url:
                return str(down_url)
        except Exception:
            pass
        return url

    def start_update(self, data):
        url = str(data.get("url") or "").strip()
        version = str(data.get("version") or "").strip()
        sha256 = str(data.get("sha256") or "").strip().lower()
        pwd = str(data.get("pwd") or "").strip()
        if not url:
            return {"ok": False, "message": "更新失败：更新地址为空"}
        print(f"[更新] 点击更新：version={version or '-'} url={url}", flush=True)
        if not self.is_direct_download_url(url):
            try:
                print("[更新] 非直链，打开下载页面后关闭软件", flush=True)
                webbrowser.open(url)
                self.shutdown_and_close()
                return {"ok": True, "message": "更新地址不是直链，已打开下载页面"}
            except Exception as exc:
                print("[更新] 打开下载链接失败：" + sunny_error_cn(exc), flush=True)
                return {"ok": False, "message": "打开更新链接失败：" + sunny_error_cn(exc)}
        if not is_packaged_app():
            return {"ok": False, "message": "当前是源码运行模式，请打包成 exe 后测试自动更新"}

        def worker():
            try:
                self.backend.detach_sync()
            except Exception:
                write_debug_log("update detach failed:\n" + traceback.format_exc())
            try:
                download_url = self.resolve_download_url(url, pwd)
                print(f"[更新] 直链下载开始：{download_url}", flush=True)
                current_exe = Path(sys.executable).resolve() if is_packaged_app() else Path(__file__).resolve()
                suffix = ".exe" if current_exe.suffix.lower() == ".exe" else ".py"
                new_file = APP_DIR / f"TBH_update_{version or int(time.time())}{suffix}"
                headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                raw, _, _ = http_request(download_url, headers=headers, timeout=120)
                new_file.write_bytes(raw)
                print(f"[更新] 下载完成：{new_file}，大小 {len(raw)} 字节", flush=True)
                if sha256:
                    got = hashlib.sha256(new_file.read_bytes()).hexdigest().lower()
                    print(f"[更新] SHA256={got}", flush=True)
                    if got != sha256:
                        new_file.unlink(missing_ok=True)
                        print("[更新] 文件校验失败", flush=True)
                        self.backend.add_log("更新失败：文件校验失败")
                        return
                updater = APP_DIR / "TBH_update_apply.bat"
                log_file = APP_DIR / "TBH_update.log"
                bat = (
                    "@echo off\r\n"
                    "chcp 65001 >nul\r\n"
                    "setlocal\r\n"
                    f"set \"OLD={current_exe}\"\r\n"
                    f"set \"NEW={new_file}\"\r\n"
                    f"set \"LOG={log_file}\"\r\n"
                    "echo 等待旧版本退出... > \"%LOG%\"\r\n"
                    "timeout /t 2 /nobreak >nul\r\n"
                    ":wait_old\r\n"
                    "move /y \"%NEW%\" \"%OLD%\" >> \"%LOG%\" 2>&1\r\n"
                    "if errorlevel 1 (\r\n"
                    "  timeout /t 1 /nobreak >nul\r\n"
                    "  goto wait_old\r\n"
                    ")\r\n"
                    "start \"\" \"%OLD%\"\r\n"
                    "del \"%~f0\" >nul 2>&1\r\n"
                )
                updater.write_text(bat, encoding="utf-8")
                print(f"[更新] 替换脚本已生成：{updater}", flush=True)
                subprocess.Popen(["cmd", "/c", str(updater)], cwd=str(APP_DIR), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                print("[更新] 替换脚本已启动，准备关闭旧版本", flush=True)
                if self.window_id:
                    try:
                        from jadeview import window
                        window.close_window(self.window_id)
                    except Exception:
                        pass
                if self.shutdown:
                    self.shutdown()
            except Exception as exc:
                print("[更新] 更新失败：" + sunny_error_cn(exc), flush=True)
                self.backend.add_log("更新失败：" + sunny_error_cn(exc))

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "message": "正在下载更新，完成后会自动关闭旧版本并重启"}

    def window_action(self, action):
        if not self.window_id:
            return {"ok": False, "message": "窗口尚未初始化"}
        from jadeview import window
        if action == "minimize":
            window.minimize_window(self.window_id)
        elif action == "maximize":
            window.toggle_maximize_window(self.window_id)
        elif action == "close":
            return self.shutdown_and_close()
        return {"ok": True, "message": f"窗口操作：{action}"}

    def choose_box_template(self, data):
        try:
            from jadeview import dialog
            raw_kind = str((data or {}).get("kind") or "")
            is_boss = raw_kind == "boss"
            kind = "首领箱" if is_boss else "普通箱"
            result = dialog.show_open_dialog(
                self.window_id or 0,
                title=f"选择{kind}图片",
                default_path=str(APP_DIR),
                button_label="选择",
                filters='[{"name":"图片文件","extensions":["png","jpg","jpeg","bmp","webp"]}]',
                properties="openFile",
            ) or {}
            paths = []
            if isinstance(result, dict):
                for key in ("file_paths", "filePaths", "paths", "files"):
                    value = result.get(key)
                    if isinstance(value, (list, tuple)):
                        paths = [str(x) for x in value if str(x)]
                        break
                if not paths:
                    value = result.get("path") or result.get("file_path") or result.get("filePath")
                    if value:
                        paths = [str(value)]
            elif isinstance(result, (str, Path)):
                paths = [str(result)]
            canceled = bool(result.get("canceled")) if isinstance(result, dict) else False
            if canceled or not paths:
                return {"ok": False, "canceled": True, "message": "已取消选择"}
            path = str(paths[0])
            if is_boss:
                self.backend.config["autoOpenBossTemplatePath"] = path
            else:
                self.backend.config["autoOpenNormalTemplatePath"] = path
            self.backend.save_config()
            return {"ok": True, "message": f"已选择{kind}图片", "path": path}
        except Exception as exc:
            return {"ok": False, "message": "选择图片失败：" + sunny_error_cn(exc)}

    def shutdown_and_close(self):
        def worker():
            try:
                self.backend.sync_time_if_shifted(quiet=True)
            except Exception:
                write_debug_log("shutdown sync time failed:\n" + traceback.format_exc())
            try:
                self.backend.detach_sync()
            except Exception:
                write_debug_log("shutdown detach failed:\n" + traceback.format_exc())
            try:
                from jadeview import window
                if self.window_id:
                    window.close_window(self.window_id)
            except Exception:
                write_debug_log("shutdown close window failed:\n" + traceback.format_exc())
            if self.shutdown:
                self.shutdown()

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "message": "正在关闭代理并断开连接"}


def ui_static_dir():
    if is_packaged_app():
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or str(APP_DIR)
        return Path(base) / "canfeng.tbh.dropitems_data" / "jade_drop_items_ui"
    return APP_DIR / "jade_drop_items_ui"


def write_runtime_config(root, item_catalog=None, donate_src="donate.jpg"):
    if item_catalog is None:
        try:
            temp_backend = DropBackend()
            item_catalog = temp_backend.item_catalog
        except Exception:
            item_catalog = []
    payload = {
        "itemCatalog": list(item_catalog or []),
        "isPackagedApp": bool(is_packaged_app()),
        "appVersion": APP_VERSION,
        "donateImageSrc": donate_src,
    }
    script = "window.TBH_RUNTIME_CONFIG = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (root / "runtime_config.js").write_text(script, encoding="utf-8")


def write_test_html(item_catalog=None):
    source_root = RESOURCE_DIR / "jade_drop_items_ui"
    if not (source_root / "index.html").exists():
        source_root = APP_DIR / "jade_drop_items_ui"
    if not (source_root / "index.html").exists():
        message = f"UI 缺少 index.html，请检查打包命令是否包含 --include-data-dir=\"jade_drop_items_ui=jade_drop_items_ui\": {source_root}"
        write_debug_log(message)
        raise FileNotFoundError(message)

    root = ui_static_dir()
    if source_root.resolve() != root.resolve():
        if root.exists():
            shutil.rmtree(root)
        shutil.copytree(source_root, root)
    else:
        root.mkdir(parents=True, exist_ok=True)

    donate_candidates = [
        APP_DIR / "??.jpg",
        RESOURCE_DIR / "??.jpg",
        source_root / "donate.jpg",
    ]
    donate_candidates.extend([p for p in APP_DIR.glob("*.jpg") if p not in donate_candidates])
    donate_path = next((p for p in donate_candidates if p.exists()), None)
    donate_src = "donate.jpg"
    if donate_path:
        donate_copy = root / "donate.jpg"
        try:
            if donate_path.resolve() != donate_copy.resolve():
                shutil.copy2(donate_path, donate_copy)
        except Exception:
            donate_src = "data:image/jpeg;base64," + base64.b64encode(donate_path.read_bytes()).decode("ascii")
    write_runtime_config(root, item_catalog, donate_src)
    return root


def find_free_tcp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def sunny_error_cn(error):
    text = str(error or "").strip()
    lower = text.lower()
    if not text:
        return "未知错误"
    if "bind" in lower or "only one usage" in lower or "address already in use" in lower:
        return "端口被占用"
    if "access is denied" in lower or "permission" in lower:
        return "权限不足，请用管理员权限运行"
    if "certificate" in lower or "cert" in lower:
        return "证书安装失败"
    if "driver" in lower or "windivert" in lower or "drive" in lower:
        return "驱动加载失败"
    if "could not find module" in lower or "dll" in lower:
        return "库文件加载失败，请检查 SunnyNet DLL 是否完整"
    if "process" in lower:
        return "进程规则设置失败"
    return text


def sunny_error_detail(error):
    text = str(error or "").strip()
    cn = sunny_error_cn(error)
    if text and text != cn:
        return f"{cn}（原始错误：{text}）"
    return cn


def frida_error_cn(error):
    return sunny_error_cn(error)


class SYSTEMTIME(ctypes.Structure):
    _fields_ = [
        ("wYear", ctypes.wintypes.WORD),
        ("wMonth", ctypes.wintypes.WORD),
        ("wDayOfWeek", ctypes.wintypes.WORD),
        ("wDay", ctypes.wintypes.WORD),
        ("wHour", ctypes.wintypes.WORD),
        ("wMinute", ctypes.wintypes.WORD),
        ("wSecond", ctypes.wintypes.WORD),
        ("wMilliseconds", ctypes.wintypes.WORD),
    ]


class LUID(ctypes.Structure):
    _fields_ = [
        ("LowPart", ctypes.wintypes.DWORD),
        ("HighPart", ctypes.wintypes.LONG),
    ]


class LUID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Luid", LUID),
        ("Attributes", ctypes.wintypes.DWORD),
    ]


class TOKEN_PRIVILEGES(ctypes.Structure):
    _fields_ = [
        ("PrivilegeCount", ctypes.wintypes.DWORD),
        ("Privileges", LUID_AND_ATTRIBUTES * 1),
    ]


_SYSTEM_TIME_PRIVILEGE_READY = False
_SYSTEM_TIME_PRIVILEGE_LOCK = threading.Lock()
_SE_PRIVILEGE_ENABLED = 0x00000002
_TOKEN_ADJUST_PRIVILEGES = 0x0020
_TOKEN_QUERY = 0x0008
_ERROR_NOT_ALL_ASSIGNED = 1300
_NTP_DELTA_SECONDS = 2208988800


def enable_system_time_privilege():
    global _SYSTEM_TIME_PRIVILEGE_READY
    if os.name != "nt":
        return False
    with _SYSTEM_TIME_PRIVILEGE_LOCK:
        if _SYSTEM_TIME_PRIVILEGE_READY:
            return True
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.wintypes.HANDLE
        advapi32.OpenProcessToken.argtypes = (
            ctypes.wintypes.HANDLE,
            ctypes.wintypes.DWORD,
            ctypes.POINTER(ctypes.wintypes.HANDLE),
        )
        advapi32.OpenProcessToken.restype = ctypes.wintypes.BOOL
        advapi32.LookupPrivilegeValueW.argtypes = (
            ctypes.wintypes.LPCWSTR,
            ctypes.wintypes.LPCWSTR,
            ctypes.POINTER(LUID),
        )
        advapi32.LookupPrivilegeValueW.restype = ctypes.wintypes.BOOL
        advapi32.AdjustTokenPrivileges.argtypes = (
            ctypes.wintypes.HANDLE,
            ctypes.wintypes.BOOL,
            ctypes.POINTER(TOKEN_PRIVILEGES),
            ctypes.wintypes.DWORD,
            ctypes.c_void_p,
            ctypes.c_void_p,
        )
        advapi32.AdjustTokenPrivileges.restype = ctypes.wintypes.BOOL
        kernel32.CloseHandle.argtypes = (ctypes.wintypes.HANDLE,)
        kernel32.CloseHandle.restype = ctypes.wintypes.BOOL
        kernel32.SetLastError.argtypes = (ctypes.wintypes.DWORD,)
        kernel32.SetLastError.restype = None
        kernel32.GetLastError.restype = ctypes.wintypes.DWORD
        token = ctypes.wintypes.HANDLE()
        if not advapi32.OpenProcessToken(
            kernel32.GetCurrentProcess(),
            _TOKEN_ADJUST_PRIVILEGES | _TOKEN_QUERY,
            ctypes.byref(token),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            luid = LUID()
            if not advapi32.LookupPrivilegeValueW(None, "SeSystemtimePrivilege", ctypes.byref(luid)):
                raise ctypes.WinError(ctypes.get_last_error())
            privileges = TOKEN_PRIVILEGES()
            privileges.PrivilegeCount = 1
            privileges.Privileges[0].Luid = luid
            privileges.Privileges[0].Attributes = _SE_PRIVILEGE_ENABLED
            kernel32.SetLastError(0)
            if not advapi32.AdjustTokenPrivileges(
                token,
                False,
                ctypes.byref(privileges),
                ctypes.sizeof(privileges),
                None,
                None,
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            err = kernel32.GetLastError()
            if err == _ERROR_NOT_ALL_ASSIGNED:
                raise ctypes.WinError(err)
            _SYSTEM_TIME_PRIVILEGE_READY = True
            return True
        finally:
            kernel32.CloseHandle(token)


def set_windows_local_time(dt):
    if os.name != "nt":
        raise RuntimeError("当前系统不支持直接设置 Windows 时间")
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    enable_system_time_privilege()
    st = SYSTEMTIME(
        int(dt.year),
        int(dt.month),
        int((dt.weekday() + 1) % 7),
        int(dt.day),
        int(dt.hour),
        int(dt.minute),
        int(dt.second),
        int(dt.microsecond / 1000),
    )
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ctypes.set_last_error(0)
    if not kernel32.SetLocalTime(ctypes.byref(st)):
        raise ctypes.WinError(ctypes.get_last_error())
    return True


def _datetime_from_ntp_timestamp(raw):
    seconds, fraction = struct.unpack("!II", raw)
    unix_seconds = seconds - _NTP_DELTA_SECONDS + (fraction / 4294967296.0)
    return datetime.datetime.fromtimestamp(unix_seconds, datetime.timezone.utc)


def fetch_beijing_time_sntp(timeout=0.6, max_servers=3):
    packet = b"\x1b" + (b"\0" * 47)
    servers = (
        "ntp.aliyun.com",
        "ntp.tencent.com",
        "cn.ntp.org.cn",
        "time.windows.com",
        "pool.ntp.org",
    )
    last_error = None
    for server in servers[:max(1, int(max_servers or len(servers)))]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(timeout)
                start = time.perf_counter()
                sock.sendto(packet, (server, 123))
                data, _addr = sock.recvfrom(48)
                elapsed = max(0.0, time.perf_counter() - start)
            if len(data) < 48:
                raise RuntimeError("NTP 响应长度异常")
            utc = _datetime_from_ntp_timestamp(data[40:48]) + datetime.timedelta(seconds=elapsed / 2.0)
            return utc.astimezone(datetime.timezone(datetime.timedelta(hours=8)))
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError("NTP 获取北京时间失败：" + sunny_error_cn(last_error))


def fetch_beijing_time_http(timeout=1.0, max_urls=2):
    urls = (
        "https://www.baidu.com",
        "https://www.aliyun.com",
        "https://www.qq.com",
    )
    last_error = None
    for url in urls[:max(1, int(max_urls or len(urls)))]:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="HEAD")
            start = time.perf_counter()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                date_header = resp.headers.get("Date", "")
            elapsed = max(0.0, time.perf_counter() - start)
            if not date_header:
                raise RuntimeError("HTTP Date 为空")
            dt_utc = email.utils.parsedate_to_datetime(date_header)
            if dt_utc.tzinfo is None:
                dt_utc = dt_utc.replace(tzinfo=datetime.timezone.utc)
            return (dt_utc + datetime.timedelta(seconds=elapsed / 2.0)).astimezone(
                datetime.timezone(datetime.timedelta(hours=8))
            )
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError("HTTP 获取北京时间失败：" + sunny_error_cn(last_error))


def fetch_beijing_time(timeout=0.6):
    try:
        return fetch_beijing_time_sntp(timeout=timeout, max_servers=3)
    except Exception as ntp_error:
        write_debug_log("SNTP sync failed, fallback to HTTP Date: " + sunny_error_cn(ntp_error))
        return fetch_beijing_time_http(timeout=max(0.8, timeout), max_urls=2)


def set_local_time_to_beijing(beijing_dt):
    if beijing_dt.tzinfo is not None:
        beijing_dt = beijing_dt.astimezone(datetime.timezone(datetime.timedelta(hours=8))).replace(tzinfo=None)
    return set_system_local_time(beijing_dt)


def set_windows_local_time_powershell_fallback(dt):
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    ps = f"Set-Date -Date '{dt.strftime('%Y-%m-%d %H:%M:%S')}'"
    startupinfo = None
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        capture_output=True,
        text=True,
        timeout=4,
        startupinfo=startupinfo,
        creationflags=creationflags,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip() or "PowerShell 设置时间失败")
    return True


def set_system_local_time(dt):
    try:
        return set_windows_local_time(dt)
    except Exception as api_error:
        write_debug_log("SetLocalTime failed, fallback to PowerShell: " + sunny_error_cn(api_error))
        return set_windows_local_time_powershell_fallback(dt)


def default_rewrite_lists():
    result = {}
    for level in [90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5]:
        code = f"{level:02d}"
        result[f"910{code}1"] = []
        result[f"920{code}1"] = []
    return result


class DropBackend:
    def __init__(self):
        self.device = None
        self.session = None
        self.script = None
        self.network_probe_script = None
        self.status_text = "未连接"
        self.logs = []
        self.last_drop = None
        self.display_drop = None
        self.obtained_items = {}
        self.obtained_recent = {}
        self.memory_trim_stop = threading.Event()
        self.memory_trim_thread = None
        self.record_status_stop = threading.Event()
        self.record_status_thread = None
        self.box_scan_stop = threading.Event()
        self.box_scan_thread = None
        self.ocr_scan_stop = threading.Event()
        self.ocr_scan_thread = None
        self.current_stage = "未知"
        self.pending_notify = None
        self.notify_recent = {}
        self.recorded_buttons_cache = {"time": []}
        self.recording_index_cache = None
        self.script_status_cache = {}
        self.last_game_process_check_at = 0.0
        self.game_process_check_interval = 5.0
        self.ocr_recent_text = {}
        self.ocr_recent_box_text = {}
        self.last_notice_box_signature = ""
        self.notice_box_baseline_signature = ""
        self.notice_box_baseline_time_key = ""
        self.notice_box_baseline_full_signature = ""
        self.notice_box_last_delete_at = {}
        self.notice_box_recent_deletes = []
        self.notice_box_suppressed_variants = {}
        self.notice_box_empty_cycles = 0
        self.selected_reward_recent = {}
        self.last_notice_box_raw_text = ""
        self.last_notice_box_kind = ""
        self.last_notice_box_time_key = ""
        self.last_notice_box_item_name = ""
        self.last_auto_open_box_kind = ""
        self.last_auto_open_box_at = 0.0
        self.auto_open_pending_delete_kind = ""
        self.auto_open_pending_delete_fail_count = 0
        self.auto_open_pending_delete_time_key = ""
        self.auto_open_pending_delete_token = ""
        self.auto_open_pending_box_scan_fail_count = 0
        self.expected_notice_box_kind = ""
        self.pending_box_notice_kind = ""
        self.pending_box_notice_time_key = ""
        self.ignore_next_notice_ocr_result = False
        self.pending_limit_ocr = {}
        self.monitor_hold_expected_count = 0
        self.monitor_hold_deleted_count = 0
        self.monitor_hold_expected_normal = 0
        self.monitor_hold_deleted_normal = 0
        self.monitor_hold_expected_boss = 0
        self.monitor_hold_deleted_boss = 0
        self.monitor_hold_delete_keys = set()
        self.pending_host_commands = []
        self.pending_script_exports = []
        self.log_replace_indices = {}
        self.pending_box_template_capture = None
        self.system_time_shifted = False
        self.time_shift_running = False
        self.time_shift_generation = 0
        self.last_ocr_service_error_log_at = 0.0
        self.paddle_small_rec_init_error = ""
        self.ocr_ready = False
        self.ready_loading = False
        self.ready_done = False
        self.running = False
        self.auto_started = False
        self.attaching = False
        self.attach_stage = "idle"
        self.attach_detail = ""
        self.attach_thread = None
        self.drop_list_remove_recent = {}
        self.market_refresh_requested_at = 0.0
        self.response_rewrite_indices = {}
        self.response_rewrite_config = default_rewrite_lists()
        self.name_map = {}
        self.grade_map = {}
        self.runtime_auto_open_enabled = False
        self.ui_static_root = ui_static_dir()
        self.base_url = ""
        self.config = {
            "normalCount": 30,
            "bossCount": 15,
            "clickDelayMs": 18000,
            "pressIntervalMs": 100,
            "roleDeployDelayMs": 2000,
            "switchMode": "time",
            "loopPauseEvery": 5,
            "loopPauseMs": 0,
            "timeShiftEvery": 30,
            "timeShiftRestoreMs": 2000,
            "timeShiftContinueMs": 3000,
            "autoTimeShiftOnLimit": False,
            "stageWaveCount": 0,
            "autoStartAfterRecord": True,
            "autoDepositEnabled": False,
            "autoDepositMinutes": 30,
            "watchNames": [
                {"name": "次元箭", "grade": "超凡", "id": "416171"},
                {"name": "冰冻法球", "grade": "至宝", "id": "425041"},
                {"name": "疾风箭", "grade": "超凡", "id": "416071"},
                {"name": "暗影之弓", "grade": "超凡", "id": "316171"},
                {"name": "命运之箭", "grade": "超凡", "id": "416111"},
                {"name": "暴风之杖", "grade": "超凡", "id": "326171"},
                {"name": "迅捷箭", "grade": "超凡", "id": "416141"},
                {"name": "帝国建国50周年纪念币", "grade": "至宝", "id": "160006"},
                {"name": "骑士靴", "grade": "至宝", "id": "535041"},
                {"name": "神秘之弓", "grade": "超凡", "id": "316111"},
                {"name": "次元魔法书", "grade": "超凡", "id": "436171"},
                {"name": "战士魔法书", "grade": "超凡", "id": "436141"},
                {"name": "王国50周年纪念币", "grade": "不朽", "id": "160005"},
            ],
            "watchIds": [],
            "notifyMode": "app",
            "notifySound": "ding",
            "rewriteEnabled": False,
            "rewriteLists": {},
            "autoOpenAppearDelayMs": 300,
            "autoOpenIntervalMs": 10000,
            "autoOpenNormalTemplatePath": "",
            "autoOpenBossTemplatePath": "",
            "priceDisplayMode": "watchOnly",
            "noticeRectLeftRel": DEFAULT_NOTICE_RELATIVE_RECT[0],
            "noticeRectTopRel": DEFAULT_NOTICE_RELATIVE_RECT[1],
            "noticeRectRightRel": DEFAULT_NOTICE_RELATIVE_RECT[2],
            "noticeRectBottomRel": DEFAULT_NOTICE_RELATIVE_RECT[3],
            "noticeRectLeft": int(round(DEFAULT_NOTICE_RELATIVE_RECT[0] * OCR_BASE_CAPTURE_WIDTH)),
            "noticeRectTop": int(round(DEFAULT_NOTICE_RELATIVE_RECT[1] * OCR_BASE_CAPTURE_HEIGHT)),
            "noticeRectRight": int(round(DEFAULT_NOTICE_RELATIVE_RECT[2] * OCR_BASE_CAPTURE_WIDTH)),
            "noticeRectBottom": int(round(DEFAULT_NOTICE_RELATIVE_RECT[3] * OCR_BASE_CAPTURE_HEIGHT)),
        }
        self.item_catalog = []
        self.duplicate_market_item_ids = set()
        self.market_item_id_aliases = {}
        self.market_price_map = {}
        self.market_currency_options = [
            {
                "code": code,
                "label": code,
                "symbol": STEAM_CURRENCY_SYMBOLS.get(code, code),
            }
            for code in ALL_MARKET_CURRENCY_CODES
        ]
        self.market_currency_code = DEFAULT_MARKET_CURRENCY
        self.market_version = 0
        self.market_ready = False
        self.market_live_ready = False
        self.market_refresh_thread = None
        self.market_refresh_stop = threading.Event()
        self.market_refresh_active_lock = threading.Lock()
        self.ready_success_logged = False
        self.lock = threading.RLock()
        self.load_config()
        self.load_item_catalog()
        self.config["watchNames"] = self.watch_entries_with_legacy_ids(
            self.config.get("watchNames", []),
            self.config.get("watchIds", []),
        )
        self.config["watchIds"] = self.watch_ids_from_entries(self.config.get("watchNames", []))
        self.load_market_price_cache()

    def reset_ocr_dedupe_state(self):
        with self.lock:
            self.ocr_recent_text = {}
            self.ocr_recent_box_text = {}
            self.last_notice_box_signature = ""
            self.notice_box_baseline_signature = ""
            self.notice_box_baseline_time_key = ""
            self.notice_box_baseline_full_signature = ""
            self.notice_box_last_delete_at = {}
            self.notice_box_recent_deletes = []
            self.notice_box_suppressed_variants = {}
            self.notice_box_empty_cycles = 0
            self.last_auto_open_box_kind = ""
            self.last_auto_open_box_at = 0.0
            self.auto_open_pending_delete_kind = ""
            self.auto_open_pending_delete_fail_count = 0
            self.auto_open_pending_delete_time_key = ""
            self.auto_open_pending_delete_token = ""
            self.auto_open_pending_box_scan_fail_count = 0
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
            self.expected_notice_box_kind = ""
            self.ignore_next_notice_ocr_result = False

    def load_config(self):
        try:
            cfg_path = CONFIG_PATH if CONFIG_PATH.exists() else DEFAULT_CONFIG_PATH
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            display = cfg.get("display", {})
            watch = cfg.get("watch", {})
            self.config["normalCount"] = int(display.get("normalCount", 30))
            self.config["bossCount"] = int(display.get("bossCount", 15))
            self.config["clickDelayMs"] = int(display.get("clickDelayMs", 18000))
            self.config["pressIntervalMs"] = int(display.get("pressIntervalMs", 450))
            self.config["roleDeployDelayMs"] = int(display.get("roleDeployDelayMs", 800))
            self.config["switchMode"] = "time"
            self.config["loopPauseEvery"] = int(display.get("loopPauseEvery", 0) or 0)
            self.config["loopPauseMs"] = int(display.get("loopPauseMs", 0) or 0)
            self.config["timeShiftEvery"] = int(display.get("timeShiftEvery", 16) or 16)
            self.config["timeShiftRestoreMs"] = int(display.get("timeShiftRestoreMs", 2000) or 2000)
            self.config["timeShiftContinueMs"] = int(display.get("timeShiftContinueMs", 3000) or 3000)
            self.config["autoTimeShiftOnLimit"] = display.get("autoTimeShiftOnLimit", False) is True
            self.config["stageWaveCount"] = max(0, int(display.get("stageWaveCount", 0) or 0))
            self.config["autoStartAfterRecord"] = display.get("autoStartAfterRecord", True) is not False
            self.config["autoDepositEnabled"] = False
            self.config["autoDepositMinutes"] = max(1, int(display.get("autoDepositMinutes", 30) or 30))
            auto_open = cfg.get("autoOpen", {})
            self.config["autoOpenAppearDelayMs"] = int(auto_open.get("appearDelayMs", 300) or 300)
            self.config["autoOpenIntervalMs"] = int(auto_open.get("intervalMs", 10000) or 10000)
            self.config["autoOpenNormalTemplatePath"] = str(auto_open.get("normalTemplatePath", "") or "")
            self.config["autoOpenBossTemplatePath"] = str(auto_open.get("bossTemplatePath", "") or "")
            self.config["priceDisplayMode"] = "watchOnly"
            notice_rect = auto_open.get("noticeRect", {}) or {}
            rel_left = float(notice_rect.get("left", DEFAULT_NOTICE_RELATIVE_RECT[0]) or DEFAULT_NOTICE_RELATIVE_RECT[0])
            rel_top = float(notice_rect.get("top", DEFAULT_NOTICE_RELATIVE_RECT[1]) or DEFAULT_NOTICE_RELATIVE_RECT[1])
            rel_right = float(notice_rect.get("right", DEFAULT_NOTICE_RELATIVE_RECT[2]) or DEFAULT_NOTICE_RELATIVE_RECT[2])
            rel_bottom = float(notice_rect.get("bottom", DEFAULT_NOTICE_RELATIVE_RECT[3]) or DEFAULT_NOTICE_RELATIVE_RECT[3])
            self.config["noticeRectLeftRel"] = rel_left
            self.config["noticeRectTopRel"] = rel_top
            self.config["noticeRectRightRel"] = rel_right
            self.config["noticeRectBottomRel"] = rel_bottom
            self.config["noticeRectLeft"] = int(round(rel_left * OCR_BASE_CAPTURE_WIDTH))
            self.config["noticeRectTop"] = int(round(rel_top * OCR_BASE_CAPTURE_HEIGHT))
            self.config["noticeRectRight"] = int(round(rel_right * OCR_BASE_CAPTURE_WIDTH))
            self.config["noticeRectBottom"] = int(round(rel_bottom * OCR_BASE_CAPTURE_HEIGHT))
            self.config["watchNames"] = list(watch.get("names", []) or [])
            self.config["watchIds"] = [str(x).strip() for x in (watch.get("ids", []) or []) if str(x).strip()]
            rewrite = cfg.get("rewrite", {})
            self.config["rewriteEnabled"] = False
            lists = rewrite.get("lists") or self.config.get("rewriteLists") or {}
            cleaned = {}
            for queue_id, ids in lists.items():
                if isinstance(ids, list):
                    cleaned[str(queue_id)] = [str(x).strip() for x in ids if str(x).strip()]
            if cleaned:
                self.config["rewriteLists"] = cleaned
                self.response_rewrite_config = dict(cleaned)
        except Exception as exc:
            write_debug_log("load_config failed:\n" + traceback.format_exc())
            pass

    def save_config(self):
        cfg = {
            "display": {
                "normalCount": int(self.config.get("normalCount", 30)),
                "bossCount": int(self.config.get("bossCount", 15)),
                "clickDelayMs": int(self.config.get("clickDelayMs", 18000)),
                "pressIntervalMs": int(self.config.get("pressIntervalMs", 450)),
                "roleDeployDelayMs": int(self.config.get("roleDeployDelayMs", 800)),
                "switchMode": "time",
                "loopPauseEvery": int(self.config.get("loopPauseEvery", 0)),
                "loopPauseMs": int(self.config.get("loopPauseMs", 0)),
                "timeShiftEvery": int(self.config.get("timeShiftEvery", 16)),
                "timeShiftRestoreMs": int(self.config.get("timeShiftRestoreMs", 2000)),
                "timeShiftContinueMs": int(self.config.get("timeShiftContinueMs", 3000)),
                "autoTimeShiftOnLimit": self.config.get("autoTimeShiftOnLimit", False) is True,
                "stageWaveCount": max(0, int(self.config.get("stageWaveCount", 0) or 0)),
                "autoStartAfterRecord": self.config.get("autoStartAfterRecord", True) is not False,
                "autoDepositMinutes": max(1, int(self.config.get("autoDepositMinutes", 30) or 30)),
                "actCount": 10,
                "clearBeforePrint": True,
            },
            "watch": {
                "enabled": True,
                "names": list(self.config.get("watchNames", [])),
                "ids": self.watch_ids_from_entries(self.config.get("watchNames", [])),
                "matchMode": "exact",
                "highlightBackgroundAnsi": "\u001b[30;48;5;226m",
            },
            "rewrite": {
                "lists": dict(self.config.get("rewriteLists", self.response_rewrite_config)),
            },
            "autoOpen": {
                "appearDelayMs": int(self.config.get("autoOpenAppearDelayMs", 300)),
                "intervalMs": int(self.config.get("autoOpenIntervalMs", 10000)),
                "normalTemplatePath": str(self.config.get("autoOpenNormalTemplatePath", "") or ""),
                "bossTemplatePath": str(self.config.get("autoOpenBossTemplatePath", "") or ""),
                "priceDisplayMode": "watchOnly",
                "noticeRect": {
                    "left": float(self.config.get("noticeRectLeftRel", DEFAULT_NOTICE_RELATIVE_RECT[0])),
                    "top": float(self.config.get("noticeRectTopRel", DEFAULT_NOTICE_RELATIVE_RECT[1])),
                    "right": float(self.config.get("noticeRectRightRel", DEFAULT_NOTICE_RELATIVE_RECT[2])),
                    "bottom": float(self.config.get("noticeRectBottomRel", DEFAULT_NOTICE_RELATIVE_RECT[3])),
                },
            },
        }
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return cfg

    def extract_js_object(self, source, var_name):
        import re
        marker = f"var {var_name} = {{"
        start = source.find(marker)
        if start < 0:
            return {}
        start = source.find("{", start)
        end = source.find("\n};", start)
        if end < 0:
            return {}
        body = source[start:end + 1]
        return dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]*)"', body))

    def load_item_catalog(self):
        try:
            source = SCRIPT_PATH.read_text(encoding="utf-8-sig")
            names = self.extract_js_object(source, "g_nameMap")
            grades = self.extract_js_object(source, "g_gradeMap")
            self.name_map = names
            self.grade_map = grades
            duplicate_ids, alias_map = self.build_duplicate_market_item_id_map(names, grades)
            self.duplicate_market_item_ids = duplicate_ids
            self.market_item_id_aliases = alias_map
            rows = []
            for item_id, name in names.items():
                item_id = str(item_id or "").strip()
                if self.is_duplicate_market_item_id(item_id):
                    continue
                name = str(name).strip()
                if not name or name == "?":
                    continue
                grade_key = grades.get(item_id, "")
                rows.append({
                    "id": item_id,
                    "name": name,
                    "gradeKey": grade_key,
                    "grade": self.grade_text(grade_key),
                })
            self.item_catalog = sorted(rows, key=lambda x: (-self.grade_rank(x["gradeKey"]), x["name"], x["id"]))
        except Exception as exc:
            self.add_log(f"物品列表加载失败：{exc}")

    def build_duplicate_market_item_id_map(self, names, grades):
        groups = {}
        for item_id, name in dict(names or {}).items():
            sid = str(item_id or "").strip()
            name = str(name or "").strip()
            if not sid or not name or name == "?":
                continue
            key = (name, str(dict(grades or {}).get(sid, "") or ""))
            groups.setdefault(key, []).append(sid)
        duplicate_ids = set()
        alias_map = {}
        for ids in groups.values():
            if len(ids) < 2:
                continue
            ids = sorted(ids)
            primary = next((sid[:-1] + "1" for sid in ids if sid.isdigit() and sid.endswith("2") and sid[:-1] + "1" in ids), None)
            if not primary:
                primary = ids[0]
            for sid in ids:
                if sid != primary and sid.isdigit() and sid.endswith("2"):
                    duplicate_ids.add(sid)
                    alias_map[sid] = primary
        return duplicate_ids, alias_map

    def is_duplicate_market_item_id(self, item_id):
        sid = str(item_id or "").strip()
        return sid in getattr(self, "duplicate_market_item_ids", set())

    def canonical_market_item_id(self, item_id):
        sid = str(item_id or "").strip()
        return getattr(self, "market_item_id_aliases", {}).get(sid, sid)

    def grade_text(self, grade_key):
        return {
            "COMMON": "普通",
            "UNCOMMON": "罕见",
            "RARE": "稀有",
            "LEGENDARY": "传奇",
            "IMMORTAL": "不朽",
            "ARCANA": "至宝",
            "BEYOND": "超凡",
            "CELESTIAL": "天界",
            "DIVINE": "神圣",
            "COSMIC": "宇宙",
        }.get(grade_key, "")

    def grade_rank(self, grade_key):
        order = ["", "COMMON", "UNCOMMON", "RARE", "LEGENDARY", "IMMORTAL", "ARCANA", "BEYOND", "CELESTIAL", "DIVINE", "COSMIC"]
        return order.index(grade_key) if grade_key in order else 0

    def grade_text_rank(self, grade):
        order = ["", "普通", "罕见", "稀有", "传奇", "不朽", "至宝", "超凡", "天界", "神圣", "宇宙"]
        return order.index(grade) if grade in order else 0

    def steam_market_json(self, url, timeout=30, attempts=3):
        last_error = None
        for attempt in range(max(1, int(attempts or 1))):
            request_url = url
            if attempt > 0:
                sep = "&" if "?" in request_url else "?"
                request_url = f"{request_url}{sep}_ts={int(time.time() * 1000)}"
            try:
                return self.steam_market_json_once(request_url, timeout=timeout)
            except MarketPricePayloadError as exc:
                last_error = exc
                if attempt + 1 >= max(1, int(attempts or 1)):
                    break
                time.sleep(0.8)
        raise last_error or MarketPricePayloadError("价格接口请求失败")

    def steam_market_json_once(self, url, timeout=30):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json, text/javascript, */*",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
            method="GET",
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            raise MarketPricePayloadError("价格接口返回空内容")
        if not (text.startswith("{") or text.startswith("[")):
            preview = re.sub(r"\s+", " ", text[:120])
            raise MarketPricePayloadError(f"价格接口返回非 JSON：{preview}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            preview = re.sub(r"\s+", " ", text[:120])
            raise MarketPricePayloadError(f"价格接口 JSON 解析失败：{exc}; preview={preview}") from exc

    def steam_market_parse_number(self, value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        text = str(value).strip().replace("$", "").replace(",", "")
        if not text:
            return None
        try:
            return float(text)
        except Exception:
            return None

    def steam_market_round_money(self, value):
        if value is None:
            return None
        return round(float(value), 4)

    def steam_market_clean_hash_name(self, hash_name):
        return re.sub(r"\s*\([^)]+\)\s*[A-Za-z]?\s*$", "", str(hash_name or "")).strip()

    def steam_market_extract_grade_en(self, hash_name):
        match = re.search(r"\((\w+)\)\s*[A-Za-z]$", str(hash_name or ""))
        if not match:
            return None
        grade_en = match.group(1).capitalize()
        return grade_en if grade_en in STEAM_GRADE_EN_TO_ZH else None

    def steam_market_to_zh_name(self, base_name):
        key = str(base_name or "").strip()
        aliases = STEAM_ITEM_NAME_ALIASES_ZH.get(key)
        if aliases:
            return str(aliases[0])
        return STEAM_ITEM_KEYWORDS_ZH.get(key, key)

    def steam_market_name_candidates_zh(self, base_name):
        key = str(base_name or "").strip()
        candidates = []

        def add(value):
            value = str(value or "").strip()
            if value and value not in candidates:
                candidates.append(value)

        for value in STEAM_ITEM_NAME_ALIASES_ZH.get(key, []):
            add(value)
        add(STEAM_ITEM_KEYWORDS_ZH.get(key, key))

        synonym_pairs = [
            ("法杖", "之杖"),
            ("魔法书", "魔典"),
            ("盔甲", "铠甲"),
            ("靴子", "靴"),
            ("盾牌", "盾"),
            ("宝球", "宝珠"),
            ("玉石", "翡翠玉石"),
            ("水晶之刃", "水晶刀刃"),
            ("暗影之刃", "暗影剑"),
            ("风暴", "暴风"),
            ("无尽", "无限"),
            ("秘法", "神秘"),
            ("奥术", "神秘"),
        ]
        for name in list(candidates):
            for left, right in synonym_pairs:
                if left in name:
                    add(name.replace(left, right))
                if right in name:
                    add(name.replace(right, left))
        return candidates

    def steam_market_detect_item_type(self, base_name):
        upper_name = str(base_name or "").upper()
        for keyword, item_type in STEAM_TYPE_KEYWORDS:
            if keyword.upper() in upper_name:
                return item_type
        return "Material"

    def steam_market_find_best_item_id(self, base_name, grade_en):
        target_grade = STEAM_GRADE_EN_TO_ZH.get(grade_en, grade_en or "")
        names = self.steam_market_name_candidates_zh(base_name)
        matches = [item for item in (self.item_catalog or []) if item.get("name") in names]
        if not matches:
            return None
        if target_grade:
            exact = [item for item in matches if item.get("grade") == target_grade]
            if exact:
                exact.sort(key=lambda x: str(x.get("id", "")))
                return str(exact[0].get("id") or "")
        matches = sorted(matches, key=lambda x: (-self.grade_rank(x.get("gradeKey", "")), str(x.get("id", ""))))
        return str(matches[0].get("id") or "") if matches else None

    def steam_market_build_price_map(self, sell_usd, buy_usd, rates_payload=None):
        prices = {}
        if isinstance(rates_payload, dict) and "rates" in rates_payload:
            rates = (rates_payload or {}).get("rates", {}) or {}
        else:
            rates = dict(rates_payload or FIXED_MARKET_RATES or {})
        usd_rate = float(rates.get("USD") or 0.0)
        if usd_rate <= 0:
            return prices
        sell_brl = None if sell_usd is None else self.steam_market_round_money(sell_usd / usd_rate)
        buy_brl = None if buy_usd is None else self.steam_market_round_money(buy_usd / usd_rate)
        for code in ALL_MARKET_CURRENCY_CODES:
            rate = rates.get(code)
            if rate is None:
                continue
            prices[code] = {
                "label": code,
                "symbol": STEAM_CURRENCY_SYMBOLS.get(code, code),
                "sell": None if sell_brl is None else self.steam_market_round_money(sell_brl * float(rate)),
                "buy": None if buy_brl is None else self.steam_market_round_money(buy_brl * float(rate)),
            }
        return prices

    def steam_market_should_replace_price_row(self, old_row, new_row):
        if not old_row:
            return True
        old_has_price = old_row.get("sellUsd") is not None or old_row.get("buyUsd") is not None
        new_has_price = new_row.get("sellUsd") is not None or new_row.get("buyUsd") is not None
        if old_has_price and not new_has_price:
            return False
        if not old_has_price and new_has_price:
            return True
        old_score = int(old_row.get("sellUsd") is not None) + int(old_row.get("buyUsd") is not None)
        new_score = int(new_row.get("sellUsd") is not None) + int(new_row.get("buyUsd") is not None)
        if new_score != old_score:
            return new_score > old_score
        old_sell = old_row.get("sellUsd")
        new_sell = new_row.get("sellUsd")
        if old_sell is not None and new_sell is not None and float(new_sell) < float(old_sell):
            return True
        return False

    def load_market_price_cache(self):
        try:
            if not MARKET_PRICE_CACHE_PATH.exists():
                return False
            payload = json.loads(MARKET_PRICE_CACHE_PATH.read_text(encoding="utf-8"))
            price_map = payload.get("prices") if isinstance(payload, dict) else None
            currencies = payload.get("currencies") if isinstance(payload, dict) else None
            currency_code = str(payload.get("currencyCode") or DEFAULT_MARKET_CURRENCY).strip().upper() if isinstance(payload, dict) else DEFAULT_MARKET_CURRENCY
            if not isinstance(price_map, dict) or not isinstance(currencies, list):
                return False
            cleaned_prices = {}
            for key, value in price_map.items():
                sid = self.canonical_market_item_id(key)
                if not sid or self.is_duplicate_market_item_id(sid) or not isinstance(value, dict):
                    continue
                value = dict(value)
                value["id"] = sid
                if self.steam_market_should_replace_price_row(cleaned_prices.get(sid), value):
                    cleaned_prices[sid] = value
            cleaned_currencies = []
            for row in currencies:
                if not isinstance(row, dict):
                    continue
                code = str(row.get("code") or "").strip().upper()
                if not code:
                    continue
                cleaned_currencies.append({
                    "code": code,
                    "label": str(row.get("label") or code),
                    "symbol": str(row.get("symbol") or STEAM_CURRENCY_SYMBOLS.get(code, code)),
                })
            if not cleaned_currencies:
                cleaned_currencies = [
                    {"code": code, "label": code, "symbol": STEAM_CURRENCY_SYMBOLS.get(code, code)}
                    for code in ALL_MARKET_CURRENCY_CODES
                ]
            valid_codes = {row["code"] for row in cleaned_currencies}
            if currency_code not in valid_codes:
                currency_code = DEFAULT_MARKET_CURRENCY if DEFAULT_MARKET_CURRENCY in valid_codes else cleaned_currencies[0]["code"]
            with self.lock:
                self.market_price_map = cleaned_prices
                self.market_currency_options = cleaned_currencies
                self.market_currency_code = currency_code
                self.market_ready = True
                self.market_live_ready = True
                self.market_version += 1
            return True
        except Exception:
            write_debug_log("load_market_price_cache failed:\n" + traceback.format_exc())
            return False

    def save_market_price_cache(self, price_map, currencies):
        try:
            cleaned_prices = {}
            for key, value in dict(price_map or {}).items():
                sid = self.canonical_market_item_id(key)
                if not sid or self.is_duplicate_market_item_id(sid) or not isinstance(value, dict):
                    continue
                value = dict(value)
                value["id"] = sid
                if self.steam_market_should_replace_price_row(cleaned_prices.get(sid), value):
                    cleaned_prices[sid] = value
            payload = {
                "updatedAt": int(time.time()),
                "currencyCode": self.market_currency_code,
                "currencies": list(currencies or []),
                "prices": cleaned_prices,
            }
            MARKET_PRICE_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            return True
        except Exception:
            write_debug_log("save_market_price_cache failed:\n" + traceback.format_exc())
            return False

    def visible_market_prices_for_ids(self, ids, offset=0, limit=None):
        wanted = []
        seen = set()
        for item_id in ids or []:
            sid = str(item_id or "").strip()
            if not sid or sid in seen:
                continue
            seen.add(sid)
            wanted.append(sid)
        with self.lock:
            prices = self.market_price_map or {}
            matched = {}
            for sid in wanted:
                price_key = self.canonical_market_item_id(sid)
                if price_key in prices:
                    row = dict(prices[price_key])
                    row["id"] = sid
                    matched[sid] = row
                    continue
                name = str(self.name_map.get(sid, "") or "").strip()
                grade = self.grade_text(self.grade_map.get(sid, ""))
                if not name or not grade:
                    continue
                fallback_row = None
                for value in prices.values():
                    if not isinstance(value, dict):
                        continue
                    if str(value.get("name") or "").strip() != name:
                        continue
                    if str(value.get("grade") or "").strip() != grade:
                        continue
                    if self.steam_market_should_replace_price_row(fallback_row, value):
                        fallback_row = value
                if fallback_row:
                    row = dict(fallback_row)
                    row["id"] = sid
                    matched[sid] = row
        total = len(matched)
        if offset or limit is not None:
            sliced = dict(list(matched.items())[offset:offset + (limit or total)])
            return {
                "prices": sliced,
                "total": total,
                "hasMore": (offset + len(sliced)) < total,
            }
        return {"prices": matched, "total": total, "hasMore": False}

    def parse_custom_market_price_payload(self, payload):
        if not isinstance(payload, dict):
            return None
        items = payload.get("items")
        if not isinstance(items, list):
            return None
        has_custom_shape = any(
            isinstance(row, dict) and row.get("id") is not None and row.get("name") is not None and ("cny" in row or "usd" in row)
            for row in items[:20]
        )
        if not has_custom_shape:
            return None
        currencies = [
            {"code": "CNY", "label": "CNY", "symbol": "¥"},
            {"code": "USD", "label": "USD", "symbol": "$"},
        ]
        next_map = {}
        for row in items:
            if not isinstance(row, dict):
                continue
            sid = self.canonical_market_item_id(row.get("id"))
            if not sid or self.is_duplicate_market_item_id(sid):
                continue
            sell_usd = self.steam_market_parse_number(row.get("sellUsd"))
            buy_usd = self.steam_market_parse_number(row.get("buyUsd"))
            if sell_usd is None:
                sell_usd = self.steam_market_parse_number(row.get("usd"))
            cny = self.steam_market_parse_number(row.get("cny"))
            sell_cny = self.steam_market_parse_number(row.get("sellCny"))
            buy_cny = self.steam_market_parse_number(row.get("buyCny"))
            if sell_cny is None:
                sell_cny = cny
            if cny is None:
                cny = sell_cny if sell_cny is not None else buy_cny
            if sell_usd is None and cny is not None and FIXED_MARKET_RATES.get("CNY"):
                sell_usd = self.steam_market_round_money(cny / (float(FIXED_MARKET_RATES["CNY"]) / float(FIXED_MARKET_RATES["USD"])))
            price_row = {
                "id": sid,
                "name": str(row.get("name") or self.name_map.get(sid) or sid),
                "type": str(row.get("type") or ""),
                "level": row.get("level") if "level" in row else None,
                "grade": str(row.get("grade") or self.grade_text(self.grade_map.get(sid, "")) or ""),
                "sellUsd": self.steam_market_round_money(sell_usd),
                "buyUsd": self.steam_market_round_money(buy_usd),
                "prices": {
                    "CNY": {
                        "label": "CNY",
                        "symbol": "¥",
                        "sell": self.steam_market_round_money(sell_cny if sell_cny is not None else cny),
                        "buy": self.steam_market_round_money(buy_cny),
                    },
                    "USD": {
                        "label": "USD",
                        "symbol": "$",
                        "sell": self.steam_market_round_money(sell_usd),
                        "buy": self.steam_market_round_money(buy_usd),
                    },
                },
            }
            if self.steam_market_should_replace_price_row(next_map.get(sid), price_row):
                next_map[sid] = price_row
        return next_map, currencies

    def refresh_market_prices_once(self):
        if not self.market_refresh_active_lock.acquire(blocking=False):
            return False
        try:
            try:
                payload = self.steam_market_json(STEAM_MARKET_API_URL, timeout=30)
            except MarketPricePayloadError as exc:
                with self.lock:
                    has_cached_prices = bool(self.market_price_map)
                    self.market_ready = has_cached_prices
                    self.market_live_ready = has_cached_prices
                    self.ready_loading = False
                write_debug_log(f"[市场初始化] {exc}，保留本地价格缓存")
                return False
            items = payload.get("items") or []
            if isinstance(payload, dict) and (payload.get("refreshing") is True or payload.get("ok") is False) and not items:
                with self.lock:
                    has_cached_prices = bool(self.market_price_map)
                    self.market_ready = has_cached_prices
                    self.market_live_ready = has_cached_prices
                    self.ready_loading = False
                write_debug_log("[市场初始化] 接口正在刷新或暂无数据，保留本地价格缓存")
                return False
            next_map = {}
            currencies = []
            mapped_count = 0
            priced_count = 0
            unmatched_samples = []
            custom_result = self.parse_custom_market_price_payload(payload)
            if custom_result is not None:
                next_map, currencies = custom_result
                mapped_count = len(next_map)
                priced_count = sum(1 for row in next_map.values() if row.get("sellUsd") is not None or row.get("buyUsd") is not None)
            else:
                for item in items:
                    hash_name = item.get("market_hash_name") or ""
                    base_name = self.steam_market_clean_hash_name(hash_name)
                    grade_en = self.steam_market_extract_grade_en(hash_name)
                    item_id = self.steam_market_find_best_item_id(base_name, grade_en)
                    if not item_id:
                        if len(unmatched_samples) < 12 and (item.get("lowest_sell_order") is not None or item.get("highest_buy_order") is not None):
                            unmatched_samples.append(f"{hash_name} -> {self.steam_market_to_zh_name(base_name)} / {STEAM_GRADE_EN_TO_ZH.get(grade_en, grade_en or '')}")
                        continue
                    item_id = self.canonical_market_item_id(item_id)
                    if self.is_duplicate_market_item_id(item_id):
                        continue
                    sell_usd = self.steam_market_parse_number(item.get("lowest_sell_order"))
                    buy_usd = self.steam_market_parse_number(item.get("highest_buy_order"))
                    item_type_en = self.steam_market_detect_item_type(base_name)
                    mapped_count += 1
                    if sell_usd is not None or buy_usd is not None:
                        priced_count += 1
                    price_row = {
                        "id": str(item_id),
                        "name": self.name_map.get(str(item_id), self.steam_market_to_zh_name(base_name)),
                        "type": STEAM_TYPE_EN_TO_ZH.get(item_type_en, item_type_en),
                        "level": None,
                        "grade": STEAM_GRADE_EN_TO_ZH.get(grade_en, grade_en or ""),
                        "sellUsd": self.steam_market_round_money(sell_usd),
                        "buyUsd": self.steam_market_round_money(buy_usd),
                        "prices": self.steam_market_build_price_map(sell_usd, buy_usd, FIXED_MARKET_RATES),
                    }
                    sid = str(item_id)
                    if self.steam_market_should_replace_price_row(next_map.get(sid), price_row):
                        next_map[sid] = price_row
                for code in ALL_MARKET_CURRENCY_CODES:
                    if code not in FIXED_MARKET_RATES:
                        continue
                    currencies.append({
                        "code": code,
                        "label": code,
                        "symbol": STEAM_CURRENCY_SYMBOLS.get(code, code),
                    })
            with self.lock:
                self.market_price_map = next_map
                self.market_currency_options = currencies or self.market_currency_options
                if self.market_currency_code not in {x["code"] for x in self.market_currency_options}:
                    self.market_currency_code = DEFAULT_MARKET_CURRENCY
                self.market_ready = True
                self.market_live_ready = True
                self.ready_loading = False
                self.market_version += 1
                should_log_ready_success = self.ready_done and self.ocr_ready and not self.ready_success_logged
                if should_log_ready_success:
                    self.ready_success_logged = True
            self.save_market_price_cache(next_map, self.market_currency_options)
            write_debug_log(f"[市场初始化] items={len(items)} mapped={mapped_count} priced={priced_count} stored={len(next_map)}")
            if unmatched_samples:
                write_debug_log("[市场初始化] unmatched_samples=" + " | ".join(unmatched_samples))
            if should_log_ready_success:
                self.add_log(f"价格初始化成功，来源：{STEAM_MARKET_SOURCE_LABEL}")
            return True
        finally:
            self.market_refresh_active_lock.release()

    def ensure_market_price_worker(self):
        thread = self.market_refresh_thread
        if thread and thread.is_alive():
            return
        self.market_refresh_stop.clear()
        def worker():
            while not self.market_refresh_stop.is_set():
                try:
                    self.refresh_market_prices_once()
                except Exception:
                    write_debug_log("refresh_market_prices_once failed:\n" + traceback.format_exc())
                if self.market_refresh_stop.wait(STEAM_MARKET_REFRESH_SECONDS):
                    break
        self.market_refresh_thread = threading.Thread(target=worker, daemon=True)
        self.market_refresh_thread.start()

    def refresh_market_prices_async(self):
        if self.market_refresh_thread and self.market_refresh_thread.is_alive():
            return
        now = time.time()
        if now - float(self.market_refresh_requested_at or 0.0) < 5.0:
            return
        self.market_refresh_requested_at = now
        with self.lock:
            if not self.market_ready:
                self.market_ready = False
        def worker():
            try:
                self.refresh_market_prices_once()
            except Exception:
                with self.lock:
                    self.ready_loading = False
                write_debug_log("refresh_market_prices_async failed:\n" + traceback.format_exc())
        threading.Thread(target=worker, daemon=True).start()

    def market_prices_response(self, data=None, ok=True, message=""):
        ids = []
        offset = 0
        limit = None
        if isinstance(data, dict):
            ids = data.get("ids") or []
            if isinstance(data.get("offset"), (int, float)):
                offset = max(0, int(data["offset"]))
            if isinstance(data.get("limit"), (int, float)):
                limit = max(1, int(data["limit"]))
        with self.lock:
            market_currency_code = self.market_currency_code
            market_currencies = list(self.market_currency_options or [])
            market_version = int(self.market_version or 0)
            market_ready = bool(self.market_ready)
        price_result = self.visible_market_prices_for_ids(ids, offset=offset, limit=limit)
        return {
            "ok": ok,
            "message": message,
            "ready": market_ready,
            "version": market_version,
            "currencyCode": market_currency_code,
            "currencies": market_currencies,
            "prices": price_result["prices"],
            "priceTotal": price_result["total"],
            "priceHasMore": price_result["hasMore"],
        }

    def catalog_item_by_id(self, item_id):
        sid = str(item_id or "").strip()
        if not sid:
            return None
        grade_key = self.grade_map.get(sid, "")
        name = self.name_map.get(sid, "")
        if not name:
            return None
        return {
            "id": sid,
            "name": name,
            "gradeKey": grade_key,
            "grade": self.grade_text(grade_key),
        }

    def catalog_item_by_name_grade(self, name, grade=""):
        name = str(name or "").strip()
        grade = str(grade or "").strip()
        if not name:
            return None
        matches = [item for item in self.item_catalog if item.get("name") == name]
        if grade:
            found = next((item for item in matches if item.get("grade") == grade), None)
            if found:
                return dict(found)
        if matches:
            return dict(sorted(matches, key=lambda x: (-self.grade_rank(x.get("gradeKey", "")), str(x.get("id", ""))))[0])
        return None

    def normalize_watch_entry(self, entry):
        if isinstance(entry, dict):
            item = self.catalog_item_by_id(entry.get("id")) or self.catalog_item_by_name_grade(entry.get("name"), entry.get("grade"))
            if item:
                return {"name": item["name"], "grade": item["grade"], "id": item["id"]}
            name = str(entry.get("name") or "").strip()
            grade = str(entry.get("grade") or "").strip()
            item_id = str(entry.get("id") or "").strip()
            if name:
                return {"name": name, "grade": grade, "id": item_id}
            return None
        item = self.catalog_item_by_name_grade(entry)
        if item:
            return {"name": item["name"], "grade": item["grade"], "id": item["id"]}
        name = str(entry or "").strip()
        return {"name": name, "grade": "", "id": ""} if name else None

    def normalize_watch_entries(self, entries):
        normalized = []
        seen = set()
        for entry in entries or []:
            item = self.normalize_watch_entry(entry)
            if not item:
                continue
            key = item.get("id") or f"{item.get('name', '')}|{item.get('grade', '')}"
            if key in seen:
                continue
            seen.add(key)
            normalized.append(item)
        return normalized

    def watch_entries_with_legacy_ids(self, entries, ids=None):
        raw_entries = list(entries or [])
        for raw_id in ids or []:
            sid = str(raw_id or "").strip()
            if sid:
                raw_entries.append(self.catalog_item_by_id(sid) or {"name": "", "grade": "", "id": sid})
        return self.normalize_watch_entries(raw_entries)

    def watch_ids_from_entries(self, entries, extra_ids=None):
        ids = []
        seen = set()
        for entry in entries or []:
            item = self.normalize_watch_entry(entry)
            sid = str((item or {}).get("id") or "").strip()
            if sid and sid not in seen:
                seen.add(sid)
                ids.append(sid)
        return ids

    def is_watch_item(self, item):
        item = item or {}
        item_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        grade = str(item.get("grade") or "").strip()
        for entry in self.normalize_watch_entries(self.config.get("watchNames", [])):
            if entry.get("id") and item_id and entry.get("id") == item_id:
                return True
            if entry.get("name") == name and entry.get("grade") == grade:
                return True
        return False

    def watch_entry_for_item(self, item):
        item = item or {}
        item_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        grade = str(item.get("grade") or "").strip()
        for entry in self.normalize_watch_entries(self.config.get("watchNames", [])):
            if entry.get("id") and item_id and entry.get("id") == item_id:
                return entry
            if entry.get("name") == name and entry.get("grade") == grade:
                return entry
        return None

    def item_plain(self, item_id):
        sid = str(item_id)
        grade_key = self.grade_map.get(sid, "")
        name = self.name_map.get(sid, f"未知物品 {sid}")
        grade = self.grade_text(grade_key)
        watched = self.is_watch_item({"id": sid, "name": name, "grade": grade, "gradeKey": grade_key})
        return {
            "id": sid,
            "name": name,
            "gradeKey": grade_key,
            "grade": grade,
            "watched": watched,
        }

    def add_log(self, text, frontend=True):
        clean = re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        write_debug_log(clean)
        if not frontend:
            return
        with self.lock:
            self.logs.append(clean)
            self.logs = self.logs[-300:]

    def replace_log(self, key, text, frontend=True):
        clean = re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        write_debug_log(clean)
        if not frontend:
            return
        replace_key = str(key or "").strip()
        with self.lock:
            idx = self.log_replace_indices.get(replace_key) if replace_key else None
            if isinstance(idx, int) and 0 <= idx < len(self.logs):
                self.logs[idx] = clean
            else:
                self.logs.append(clean)
                if replace_key:
                    self.log_replace_indices[replace_key] = len(self.logs) - 1
            if len(self.logs) > 300:
                drop_count = len(self.logs) - 300
                self.logs = self.logs[-300:]
                self.log_replace_indices = {
                    k: v - drop_count for k, v in self.log_replace_indices.items()
                    if isinstance(v, int) and v - drop_count >= 0
                }

    def add_log_force(self, text, frontend=True):
        clean = re.sub(r"\x1b\[[0-9;]*m", "", str(text))
        try:
            print(clean, flush=True)
        except Exception:
            pass
        write_debug_log(clean)
        if not frontend:
            return
        with self.lock:
            self.logs.append(clean)
            self.logs = self.logs[-300:]

    def pop_logs(self):
        with self.lock:
            lines = self.logs[:]
            self.logs.clear()
            self.log_replace_indices.clear()
            return lines

    def attach_start_response(self, message="正在连接中，请稍候"):
        with self.lock:
            return {
                "ok": True,
                "message": message,
                "connected": self.script is not None,
                "attaching": bool(self.attaching),
                "attachStage": str(self.attach_stage or ""),
                "attachDetail": str(self.attach_detail or ""),
                "readyDone": self.ready_done,
                "running": self.running,
                "autoStarted": self.auto_started,
                "statusText": self.status_text,
                "processText": PROCESS_NAME,
                "logs": self.pop_logs(),
            }

    def quick_state(self, message=""):
        if self.script:
            self.drain_pending_host_commands()
            self.drain_pending_script_exports()
        with self.lock:
            return {
                "ok": True,
                "message": message,
                "connected": self.script is not None,
                "attaching": bool(self.attaching),
                "attachStage": str(self.attach_stage or ""),
                "attachDetail": str(self.attach_detail or ""),
                "readyDone": self.ready_done and self.ocr_ready and self.market_live_ready,
                "readyLoading": bool(self.ready_loading),
                "running": self.running,
                "autoStarted": self.auto_started,
                "statusText": self.status_text,
                "processText": PROCESS_NAME,
                "logs": self.pop_logs(),
            }

    def attach(self):
        if self.script:
            return self.response(True, "脚本已经加载", include_script_status=False)
        if frida is None:
            return self.response(False, "未安装 frida Python 模块")
        with self.lock:
            if self.attaching:
                return self.attach_start_response()
            self.attaching = True
            self.attach_stage = "queued"
            self.attach_detail = "等待后台连接线程启动"
            self.status_text = "连接中..."
        self.add_log("正在连接并加载脚本...")
        self.add_log("[连接调试] 已提交连接请求，等待后台线程执行", frontend=False)

        def worker():
            time.sleep(0.05)
            try:
                with self.lock:
                    self.attach_stage = "worker-start"
                    self.attach_detail = "后台连接线程已启动"
                self.add_log("[连接调试] 后台连接线程已启动", frontend=False)
                self.attach_sync()
            finally:
                with self.lock:
                    self.attaching = False

        self.attach_thread = threading.Thread(target=worker, daemon=True)
        self.attach_thread.start()
        return self.attach_start_response()

    def attach_sync(self):
        try:
            self.status_text = "连接中..."
            with self.lock:
                self.attach_stage = "get-device"
                self.attach_detail = "正在获取本地 Frida 设备"
            write_debug_log(f"正在连接 {PROCESS_NAME} ...")
            self.add_log("[连接调试] 正在获取本地 Frida 设备", frontend=False)
            self.device = frida.get_local_device()
            with self.lock:
                self.attach_stage = "pick-process"
                self.attach_detail = "正在选择游戏进程"
            self.add_log("[连接调试] 本地 Frida 设备已就绪，开始查找游戏进程", frontend=False)
            target = self.pick_target_process()
            write_debug_log(f"已选择进程：{target.name} (pid: {target.pid})")
            self.add_log(f"[连接调试] 已选择进程：{target.name} (pid: {target.pid})", frontend=False)
            with self.lock:
                self.attach_stage = "session-attach"
                self.attach_detail = f"正在附加进程 pid={target.pid}"
            self.add_log(f"[连接调试] 正在附加到进程 pid={target.pid}", frontend=False)
            self.session = self.device.attach(target.pid)
            with self.lock:
                self.attach_stage = "read-script"
                self.attach_detail = f"正在读取脚本：{SCRIPT_PATH.name}"
            self.add_log(f"[连接调试] 已建立 Frida 会话，正在读取脚本：{SCRIPT_PATH.name}", frontend=False)
            source = SCRIPT_PATH.read_text(encoding="utf-8")
            with self.lock:
                self.attach_stage = "create-script"
                self.attach_detail = "正在创建主脚本对象"
            self.add_log("[连接调试] 正在创建主脚本对象", frontend=False)
            self.script = self.session.create_script(source)
            self.script.on("message", self.on_message)
            with self.lock:
                self.attach_stage = "load-script"
                self.attach_detail = "正在加载主脚本"
            self.add_log("[连接调试] 正在加载主脚本", frontend=False)
            self.script.load()
            with self.lock:
                self.attach_stage = "load-network-probe"
                self.attach_detail = "正在加载网络探针脚本"
            self.add_log("[连接调试] 主脚本已加载，正在加载网络探针脚本", frontend=False)
            self.load_frida_network_probe()
            with self.lock:
                self.attach_stage = "apply-config"
                self.attach_detail = "正在应用当前配置"
            self.status_text = "已加载"
            self.reset_ocr_dedupe_state()
            self.apply_config(self.config, silent=True)
            self.start_memory_trim_worker()
            self.start_record_status_worker()
            with self.lock:
                self.attaching = False
                self.attach_stage = "ready"
                self.attach_detail = "连接完成，等待录制按钮"
            self.add_log("[连接调试] 主脚本和网络探针均已加载完成", frontend=False)
            self.add_log("脚本加载完成，请录制按钮ui")
            return self.response(True, "脚本加载完成，请录制按钮ui", include_script_status=False)
        except Exception as exc:
            self.status_text = "连接失败"
            msg = sunny_error_cn(exc)
            with self.lock:
                current_stage = self.attach_stage
                self.attach_stage = "failed"
                self.attach_detail = msg
            self.add_log(f"[连接调试] 连接失败，阶段={current_stage}，原因：{msg}", frontend=False)
            self.add_log(f"连接失败：{msg}")
            self.cleanup_failed_attach(msg)
            return self.response(False, f"连接失败：{msg}")

    def load_frida_network_probe(self):
        if not self.session:
            raise RuntimeError("Frida 会话未建立")
        if self.network_probe_script:
            try:
                self.network_probe_script.unload()
            except Exception:
                pass
            self.network_probe_script = None
        cfg = {
            "contains": "api.thebackend.io/backend-function/base/v1",
            "maxBytes": 131072,
            "rewriteEnabled": self.config.get("rewriteEnabled", False) is True,
            "rewriteLists": self.frida_rewrite_lists(),
        }
        with self.lock:
            self.attach_detail = "正在构建网络探针脚本"
        source = build_frida_network_probe_source().replace("__CFG_JSON__", json.dumps(cfg, ensure_ascii=False))
        with self.lock:
            self.attach_detail = "正在创建网络探针脚本对象"
        self.network_probe_script = self.session.create_script(source)
        self.network_probe_script.on("message", self.on_network_probe_message)
        with self.lock:
            self.attach_detail = "正在加载网络探针脚本到游戏进程"
        self.network_probe_script.load()
        with self.lock:
            self.attach_detail = "网络探针脚本加载完成"
        self.add_log("[连接调试] 网络探针脚本加载完成", frontend=False)

    def pick_target_process(self):
        processes = [
            p for p in self.device.enumerate_processes()
            if p.name.lower() == PROCESS_NAME.lower()
        ]
        if not processes:
            raise RuntimeError(f"未找到进程：{PROCESS_NAME}")
        if len(processes) == 1:
            return processes[0]
        visible_pids = visible_window_pids()
        visible = [p for p in processes if p.pid in visible_pids]
        if visible:
            return sorted(visible, key=lambda p: p.pid, reverse=True)[0]
        return sorted(processes, key=lambda p: p.pid, reverse=True)[0]

    def detach(self):
        if not self.script and not self.session:
            self.status_text = "未连接"
            return self.response(True, "当前未连接")
        self._detach_resources(add_ui_logs=True, async_mode=True)
        return self.response(True, "已断开连接", include_script_status=False)

    def detach_sync(self):
        self._detach_resources(add_ui_logs=False, async_mode=False)
        return True

    def prepare_script_for_detach(self, script=None, add_ui_logs=False):
        script = script or self.script
        if not script:
            return
        try:
            exports = getattr(script, "exports_sync", None) or getattr(script, "exports", None)
        except Exception:
            exports = None
        try:
            if exports:
                stop_fn = getattr(exports, "stop", None)
                if stop_fn:
                    stop_fn()
        except Exception:
            write_debug_log("detach stop export failed:\n" + traceback.format_exc())
        try:
            if script:
                script.post({
                    "type": "host-command",
                    "payload": {
                        "cmd": "preparedetach",
                        "args": [],
                    },
                })
        except Exception:
            write_debug_log("detach preparedetach host-command failed:\n" + traceback.format_exc())
        try:
            if exports:
                prepare_fn = getattr(exports, "preparedetach", None)
                if prepare_fn:
                    prepare_fn()
        except Exception:
            write_debug_log("detach preparedetach export failed:\n" + traceback.format_exc())
        try:
            time.sleep(0.5)
        except Exception:
            pass
        if add_ui_logs:
            self.add_log("正在安全停止脚本...")

    def _detach_resources(self, add_ui_logs=False, async_mode=True):
        script = self.script
        network_probe_script = self.network_probe_script
        session = self.session
        self.script = None
        self.network_probe_script = None
        self.session = None
        self.device = None
        self.last_drop = None
        self.display_drop = None
        self.running = False
        self.auto_started = False
        self.ready_loading = False
        self.status_text = "未连接"
        self.stop_memory_trim_worker()
        self.stop_record_status_worker()
        with self.lock:
            self.recorded_buttons_cache = {"time": []}
            self.recording_index_cache = None
            self.script_status_cache = {}
            self.last_game_process_check_at = 0.0
            self.runtime_auto_open_enabled = False
            self.reset_ocr_dedupe_state()
        self.stop_box_scan_worker()
        self.stop_notice_ocr_worker()
        if add_ui_logs:
            self.add_log("正在断开连接...")

        def worker():
            try:
                try:
                    self.prepare_script_for_detach(script=script, add_ui_logs=add_ui_logs)
                except Exception:
                    write_debug_log("prepare detach failed:\n" + traceback.format_exc())
                try:
                    self.sync_time_if_shifted(quiet=True)
                except Exception:
                    write_debug_log("detach sync time failed:\n" + traceback.format_exc())
                try:
                    if network_probe_script:
                        network_probe_script.unload()
                except Exception:
                    pass
                try:
                    if script:
                        script.unload()
                except Exception:
                    pass
                try:
                    if session:
                        session.detach()
                except Exception:
                    pass
            except Exception:
                pass
            if add_ui_logs:
                self.add_log("已断开连接")

        if async_mode:
            threading.Thread(target=worker, daemon=True).start()
        else:
            worker()

    def cleanup_failed_attach(self, reason=""):
        script = self.script
        network_probe_script = self.network_probe_script
        session = self.session
        self.script = None
        self.network_probe_script = None
        self.session = None
        self.device = None
        self.last_drop = None
        self.display_drop = None
        self.running = False
        self.auto_started = False
        self.attaching = False
        self.attach_stage = "idle"
        self.attach_detail = ""
        self.ready_loading = False
        self.status_text = "未连接"
        self.stop_memory_trim_worker()
        self.stop_record_status_worker()
        with self.lock:
            self.recorded_buttons_cache = {"time": []}
            self.recording_index_cache = None
            self.script_status_cache = {}
            self.last_game_process_check_at = 0.0
            self.runtime_auto_open_enabled = False
            self.reset_ocr_dedupe_state()
        self.stop_box_scan_worker()
        self.stop_notice_ocr_worker()
        try:
            self.prepare_script_for_detach(script=script, add_ui_logs=False)
        except Exception:
            write_debug_log("cleanup prepare detach failed:\n" + traceback.format_exc())
        try:
            if network_probe_script:
                network_probe_script.unload()
        except Exception:
            pass
        try:
            if script:
                script.unload()
        except Exception:
            pass
        try:
            if session:
                session.detach()
        except Exception:
            pass
        if reason:
            with self.lock:
                self.attach_stage = "failed"
                self.attach_detail = str(reason)
            write_debug_log(f"attach cleanup after failure: {reason}")

    def set_local_rpc_state(self, name):
        if name == "ready":
            cached_market_ready = bool(self.market_ready and self.market_price_map)
            self.ready_done = True
            self.ready_loading = not cached_market_ready
            self.market_live_ready = cached_market_ready
            self.auto_started = False
            if cached_market_ready and not self.ready_success_logged:
                self.ready_success_logged = True
                self.add_log(f"价格初始化成功，来源：{STEAM_MARKET_SOURCE_LABEL}")
        elif name == "start":
            self.running = True
            self.auto_started = True
            self.reset_ocr_dedupe_state()
            threading.Thread(target=self.initialize_notice_box_baseline_once, daemon=True).start()
        elif name == "stop":
            self.running = False
            self.auto_started = False
            self.time_shift_running = False
            self.time_shift_generation += 1
            self.pending_limit_ocr = {}
            self.pending_host_commands = []
            self.pending_script_exports = []
            self.reset_monitor_hold_progress(0)
            self.stop_notice_ocr_worker()
            self.stop_box_scan_worker()
        elif name == "clear":
            self.running = False
            self.auto_started = False
            self.time_shift_running = False
            self.time_shift_generation += 1
            self.pending_limit_ocr = {}
            self.pending_host_commands = []
            self.pending_script_exports = []
            self.reset_monitor_hold_progress(0)
            with self.lock:
                mode = "time"
                self.recorded_buttons_cache[mode] = []

    def call_script_rpc_async(self, name):
        self.post_frida(name)

    def enqueue_host_command(self, cmd, args=None, note=""):
        with self.lock:
            self.pending_host_commands.append({
                "cmd": str(cmd),
                "args": list(args or []),
                "note": str(note or ""),
            })

    def enqueue_script_export(self, name, args=None, note=""):
        with self.lock:
            self.pending_script_exports.append({
                "name": str(name),
                "args": list(args or []),
                "note": str(note or ""),
            })

    def drain_pending_host_commands(self):
        with self.lock:
            queue = list(self.pending_host_commands)
            self.pending_host_commands.clear()
        for item in queue:
            cmd = str(item.get("cmd") or "")
            args = list(item.get("args") or [])
            note = str(item.get("note") or "")
            ok = self.post_frida(cmd, args)
            if ok:
                if note:
                    self.add_log_force(note)
            else:
                self.add_log_force(f"[后台指令] 发送失败：{cmd}({', '.join(str(x) for x in args)})")

    def drain_pending_script_exports(self):
        with self.lock:
            queue = list(self.pending_script_exports)
            self.pending_script_exports.clear()
        for item in queue:
            name = str(item.get("name") or "")
            args = list(item.get("args") or [])
            note = str(item.get("note") or "")
            try:
                result = self.call_script_export(name, *args)
                if note:
                    self.add_log_force(f"{note} -> {result}")
                else:
                    self.add_log_force(f"[后台导出] {name}({', '.join(str(x) for x in args)}) -> {result}")
            except Exception as exc:
                self.add_log_force(f"[后台导出] 执行失败：{name}({', '.join(str(x) for x in args)}) -> {sunny_error_cn(exc)}")

    def post_frida(self, cmd, args=None):
        script = self.script
        if not script:
            return False
        try:
            script.post({
                "type": "host-command",
                "payload": {
                    "cmd": str(cmd),
                    "args": list(args or []),
                },
            })
            return True
        except Exception as exc:
            self.add_log(f"后台操作失败（{cmd}）：{sunny_error_cn(exc)}")
            write_crash_log(f"Frida post failed: {cmd}\n" + traceback.format_exc())
            return False

    def rpc(self, name):
        if not self.script:
            return self.response(False, "请先点击连接并加载脚本")
        if name in ("ready", "start", "stop", "startcross", "stopcross", "clear", "status"):
            if name == "status":
                return self.response(True, "状态：已连接", include_script_status=False)
            if name == "ready":
                self.ready_loading = True
                ok, message = self.ensure_notice_ocr_ready()
                if not ok:
                    self.ready_loading = False
                    self.ready_done = False
                    return self.response(False, message, include_script_status=False)
                self.ensure_market_price_worker()
                self.refresh_market_prices_async()
            if name == "stop":
                self.set_local_rpc_state(name)
                def stop_worker():
                    try:
                        self.sync_time_if_shifted(quiet=True)
                    except Exception:
                        write_debug_log("stop sync time failed:\n" + traceback.format_exc())
                    self.call_script_rpc_async(name)
                threading.Thread(target=stop_worker, daemon=True).start()
                return self.response(True, self.format_rpc_result(name, "queued"), include_script_status=False)
            if name == "start":
                self.start_memory_trim_worker()
                self.set_local_rpc_state(name)
                self.call_script_rpc_async(name)
                return self.response(True, self.format_rpc_result(name, "queued"), include_script_status=False)
            if name == "startcross":
                self.start_memory_trim_worker()
                self.set_local_rpc_state("start")
                self.call_script_rpc_async(name)
                return self.response(True, "跨难度循环已启动", include_script_status=True)
            if name == "stopcross":
                self.set_local_rpc_state("stop")
                self.call_script_rpc_async(name)
                return self.response(True, "跨难度循环已停止", include_script_status=True)
            self.set_local_rpc_state(name)
            self.call_script_rpc_async(name)
            return self.response(True, self.format_rpc_result(name, "queued"), include_script_status=False)
        try:
            self.post_frida(name)
            result = "queued"
            if name == "status":
                try:
                    status_data = json.loads(result)
                    self.current_stage = status_data.get("currentStage") or self.current_stage
                except Exception:
                    pass
            self.set_local_rpc_state(name)
            return self.response(True, self.format_rpc_result(name, result))
        except Exception as exc:
            return self.response(False, f"操作失败（{name}）：{sunny_error_cn(exc)}")

    def detach_after_game_exit(self):
        if not self.script and not self.session:
            self.status_text = "未连接"
            return
        try:
            try:
                self.prepare_script_for_detach(script=self.script, add_ui_logs=False)
            except Exception:
                write_debug_log("detach_after_game_exit prepare detach failed:\n" + traceback.format_exc())
            try:
                if self.network_probe_script:
                    self.network_probe_script.unload()
            except Exception:
                pass
            try:
                if self.script:
                    self.script.unload()
            except Exception:
                pass
            try:
                if self.session:
                    self.session.detach()
            except Exception:
                pass
        finally:
            self.script = None
            self.network_probe_script = None
            self.session = None
            self.device = None
            self.running = False
            self.auto_started = False
            self.attaching = False
            self.ready_loading = False
            self.status_text = "未连接"
            self.current_stage = "未知"
            self.stop_memory_trim_worker()
            self.add_log("检测到游戏已退出，已自动断开连接")

    def ensure_game_process_alive(self):
        if not self.script and not self.session:
            return
        now = time.monotonic()
        if now - float(getattr(self, "last_game_process_check_at", 0.0) or 0.0) < float(getattr(self, "game_process_check_interval", 5.0) or 5.0):
            return
        self.last_game_process_check_at = now
        if self.find_taskbarhero_pids():
            return
        self.detach_after_game_exit()

    def on_message(self, message, data):
        msg_type = message.get("type")
        if msg_type == "send":
            payload = message.get("payload")
            if isinstance(payload, dict) and payload.get("type") == "drop_update":
                with self.lock:
                    self.current_stage = payload.get("currentStage") or self.current_stage
                    self.last_drop = copy.deepcopy(payload)
                    self.display_drop = copy.deepcopy(payload)
                    self.last_drop["currentStage"] = self.current_stage
                    self.display_drop["currentStage"] = self.current_stage
            elif isinstance(payload, dict) and payload.get("type") == "selected":
                item_id = int(payload.get("itemId") or 0)
                if item_id > 0:
                    self.handle_selected_drop(item_id)
            elif isinstance(payload, dict) and payload.get("type") == "log":
                text = str(payload.get("text", ""))
                if text.startswith("[箱子掉落]"):
                    self.add_log(f"[OCR] {text}")
            elif isinstance(payload, dict) and payload.get("type") == "ui_status":
                text = payload.get("text", "")
                replace_key = str(payload.get("replaceKey") or "").strip()
                self.update_stage_from_text(text)
                self.update_loop_state_from_text(text)
                if "监控物品已掉落(Hook掉落)" in str(text):
                    return
                if "请先打开地图界面" not in str(text):
                    if replace_key:
                        self.replace_log(replace_key, text)
                    else:
                        self.add_log(text)
            elif isinstance(payload, dict) and payload.get("type") == "time_shift_cycle":
                self.run_time_shift_cycle(
                    int(payload.get("minutes", 15) or 15),
                    int(payload.get("restoreDelayMs", 2000) or 2000),
                    int(payload.get("continueDelayMs", 8000) or 8000),
                )
            elif isinstance(payload, dict) and payload.get("type") == "drop_event":
                pass
            elif isinstance(payload, dict) and payload.get("type") == "selected_box_drop":
                pass
            elif isinstance(payload, dict) and payload.get("type") == "watch_detected":
                items = [item for item in (payload.get("items", []) or []) if self.visible_watch_item(item)]
                normal_expected = 0
                boss_expected = 0
                for item in items:
                    queue_label = str((item or {}).get("queueLabel") or "")
                    if "首领" in queue_label or "boss" in queue_label.lower():
                        boss_expected += 1
                    else:
                        normal_expected += 1
                self.reset_monitor_hold_progress(len(items), normal_expected=normal_expected, boss_expected=boss_expected)
                self.queue_watch_notify(items)
            elif isinstance(payload, dict) and payload.get("type") == "limit_wait_check":
                self.handle_limit_wait_check(payload)
            elif isinstance(payload, dict) and payload.get("type") == "limit_wait_timeout":
                self.handle_limit_wait_timeout(payload)
            elif isinstance(payload, dict) and payload.get("type") == "selected_reward":
                self.handle_selected_reward_drop(payload)
        elif msg_type == "error":
            self.add_log("脚本运行异常，请查看本地日志")
            write_debug_log("frida script error:\n" + str(message.get("stack", message)))

    def on_network_probe_message(self, message, data):
        msg_type = message.get("type")
        if msg_type == "send":
            payload = message.get("payload")
            if not isinstance(payload, dict):
                return
            kind = str(payload.get("kind") or "")
            if kind == "stage_request":
                stage = str(payload.get("stage") or "").strip()
                if stage:
                    with self.lock:
                        self.current_stage = stage
                return
            if kind == "rewrite_applied":
                modified = int(payload.get("modified") or 0)
                if modified > 0:
                    stage = str(payload.get("stage") or "").strip()
                    queues = payload.get("queues") or []
                    queue_text = "、".join(str(x) for x in queues if str(x).strip())
                    extra = f"（{queue_text}）" if queue_text else ""
                    stage_text = f"{stage} " if stage else ""
                    self.add_log(f"[替换] {stage_text}响应已按箱子等级替换 {modified} 个 rewardItemId{extra}")
                return
            if kind == "process_box_response":
                body = str(payload.get("text") or "")
                stage = str(payload.get("stage") or "").strip()
                if not body:
                    return
                self.handle_sunny_response(body, stage)
                return
        elif msg_type == "error":
            write_debug_log("frida network probe error:\n" + str(message.get("stack", message)))

    def record_button(self, index):
        if not self.script:
            return self.response(False, "请先点击连接并加载脚本")
        try:
            index = int(index)
        except Exception:
            return self.response(False, "录制失败: 无效的按钮序号")

        with self.lock:
            rows = list(self.recorded_buttons_cache.get("time") or [])
            while len(rows) <= index:
                rows.append(None)
            rows[index] = None
            self.recorded_buttons_cache["time"] = rows
            self.recording_index_cache = index
        try:
            self.call_script_export("recordbutton", index)
        except Exception:
            self.post_frida("recordbutton", [index])
        return self.response(True, "请在游戏中点击对应按钮", include_script_status=True)

    def clear_record_button(self, index):
        if not self.script:
            return self.response(False, "请先点击连接并加载脚本")
        try:
            index = int(index)
        except Exception:
            return self.response(False, "清空失败: 无效的按钮序号")
        with self.lock:
            rows = list(self.recorded_buttons_cache.get("time") or [])
            while len(rows) <= index:
                rows.append(None)
            rows[index] = None
            self.recorded_buttons_cache["time"] = rows
            if self.recording_index_cache == index:
                self.recording_index_cache = None
        self.post_frida("clearrecordbutton", [index])
        return self.response(True, "已清空录制按钮", include_script_status=True)

    def cache_recorded_buttons(self, recorded):
        if isinstance(recorded, list):
            recorded = {"time": recorded}
        if not isinstance(recorded, dict):
            return
        with self.lock:
            for mode in ("time",):
                rows = recorded.get(mode)
                if isinstance(rows, list):
                    self.recorded_buttons_cache[mode] = rows

    def merge_recorded_button_rows(self, primary, fallback):
        result = []
        max_len = max(len(primary or []), len(fallback or []))
        for index in range(max_len):
            row = primary[index] if index < len(primary or []) else None
            fallback_row = fallback[index] if index < len(fallback or []) else None
            if isinstance(row, dict) and row.get("ptr"):
                result.append(row)
            elif isinstance(fallback_row, dict) and fallback_row.get("ptr"):
                result.append(fallback_row)
            else:
                result.append(row if row is not None else fallback_row)
        return result

    def current_recorded_buttons_cache(self):
        mode = "time"
        with self.lock:
            rows = self.recorded_buttons_cache.get(mode) or []
            return list(rows)

    def record_status_response(self):
        with self.lock:
            recorded_buttons = list(self.recorded_buttons_cache.get("time") or [])
            recording_index = self.recording_index_cache
            script_status = dict(self.script_status_cache or {})
        return {
            "ok": True,
            "connected": self.script is not None,
            "recordedButtons": recorded_buttons,
            "recordingIndex": recording_index,
            "running": bool(script_status.get("running")),
            "crossLoop": script_status.get("crossLoop", {}) if isinstance(script_status.get("crossLoop"), dict) else {},
            "autoDeposit": script_status.get("autoDeposit", {}) if isinstance(script_status.get("autoDeposit"), dict) else {},
        }

    def is_recording_active(self):
        script = self.script
        if not script:
            return False
        try:
            exports = getattr(script, "exports_sync", None) or getattr(script, "exports", None)
            if not exports:
                return False
            raw = exports.status()
            data = json.loads(raw) if isinstance(raw, str) else (raw or {})
            self.cache_recorded_buttons(data.get("recordSets") or data.get("recorded") or {})
            return isinstance(data, dict) and data.get("recordingIndex") is not None
        except Exception as exc:
            write_debug_log(f"recording status check failed: {sunny_error_cn(exc)}")
            return False

    def restore_recorded_buttons_cache(self):
        return

    def get_script_status(self):
        if not self.script:
            return {}
        try:
            exports = getattr(self.script, "exports_sync", None) or getattr(self.script, "exports", None)
            if not exports:
                return {}
            raw = exports.status()
            data = json.loads(raw) if isinstance(raw, str) else (raw or {})
            self.cache_recorded_buttons(data.get("recordSets") or data.get("recorded") or {})
            return data if isinstance(data, dict) else {}
        except Exception as exc:
            write_debug_log(f"get script status failed: {sunny_error_cn(exc)}")
            return {}

    def call_script_export(self, name, *args):
        script = self.script
        if not script:
            return None
        exports = getattr(script, "exports_sync", None) or getattr(script, "exports", None)
        if not exports:
            return None
        fn = getattr(exports, str(name), None)
        if not fn:
            raise AttributeError(f"script export not found: {name}")
        return fn(*args)

    def update_stage_from_text(self, text):
        if not text:
            return
        m = re.search(r"(?:当前识别|手动点击)：([^，,（(]+)", str(text))
        if not m:
            return
        part = m.group(1).strip()
        if part == "#1":
            part = "低等级关卡"
        elif part == "#2":
            part = "高等级关卡"
        elif part in ("折磨1-2", "1-2"):
            part = "低等级关卡"
        elif part in ("折磨1-3", "1-3"):
            part = "高等级关卡"
        if part:
            self.current_stage = part

    def next_time_stage_index(self, stage_label):
        stage = str(stage_label or "")
        if "低等级" in stage or "LV5" in stage or "LV10" in stage or "LV15" in stage or "LV20" in stage or "LV25" in stage or "LV30" in stage or "LV35" in stage or "LV40" in stage or "LV45" in stage:
            return 1
        return 0

    def reset_monitor_hold_progress(self, expected_count=0, normal_expected=0, boss_expected=0):
        with self.lock:
            self.monitor_hold_expected_count = max(0, int(expected_count or 0))
            self.monitor_hold_deleted_count = 0
            self.monitor_hold_expected_normal = max(0, int(normal_expected or 0))
            self.monitor_hold_deleted_normal = 0
            self.monitor_hold_expected_boss = max(0, int(boss_expected or 0))
            self.monitor_hold_deleted_boss = 0
            self.monitor_hold_delete_keys = set()

    def mark_monitor_hold_deleted_once(self, unique_key):
        key = str(unique_key or "").strip()
        if not key:
            return False
        parts = key.split("|")
        box_kind = parts[1] if len(parts) > 1 else ""
        with self.lock:
            existing = set(self.monitor_hold_delete_keys or set())
            if key in existing:
                return False
            existing.add(key)
            self.monitor_hold_delete_keys = existing
            self.monitor_hold_deleted_count = int(self.monitor_hold_deleted_count or 0) + 1
            if box_kind == "普通":
                self.monitor_hold_deleted_normal = int(self.monitor_hold_deleted_normal or 0) + 1
            elif box_kind == "首领":
                self.monitor_hold_deleted_boss = int(self.monitor_hold_deleted_boss or 0) + 1
        return True

    def monitor_hold_progress(self):
        with self.lock:
            expected = int(self.monitor_hold_expected_count or 0)
            deleted = int(self.monitor_hold_deleted_count or 0)
            normal_expected = int(self.monitor_hold_expected_normal or 0)
            normal_deleted = int(self.monitor_hold_deleted_normal or 0)
            boss_expected = int(self.monitor_hold_expected_boss or 0)
            boss_deleted = int(self.monitor_hold_deleted_boss or 0)
        return {
            "expected": expected,
            "deleted": deleted,
            "normalExpected": normal_expected,
            "normalDeleted": normal_deleted,
            "bossExpected": boss_expected,
            "bossDeleted": boss_deleted,
        }

    def notice_delete_unique_key(self, category, box_kind="", time_key="", name=""):
        return "|".join([
            str(category or "").strip(),
            str(box_kind or "").strip(),
            str(time_key or "").strip(),
            str(name or "").strip(),
        ])

    def normalized_notice_name(self, text):
        value = str(text or "").strip()
        if not value:
            return ""
        value = re.sub(r"\[[^\]]*\]", "", value)
        value = re.sub(r"\([^\)]*\)", "", value)
        value = re.sub(r"[【】\[\]\(\)\s]", "", value)
        value = value.replace("获得了", "")
        value = re.sub(r"[^\u4e00-\u9fff]", "", value)
        return value

    def match_notice_item_to_expected(self, item_name, expected):
        item_name = self.normalized_notice_name(item_name)
        expected_name = self.normalized_notice_name((expected or {}).get("name") or "")
        if not item_name or not expected_name:
            return False
        if item_name == expected_name:
            return True
        if item_name in expected_name or expected_name in item_name:
            shorter = min(len(item_name), len(expected_name))
            if shorter >= 2:
                return True
        try:
            return SequenceMatcher(None, item_name, expected_name).ratio() >= 0.76
        except Exception:
            return False

    def current_waiting_stage_index(self):
        try:
            status = self.get_script_status() if self.script else {}
        except Exception:
            status = {}
        if isinstance(status, dict):
            waiting_index = status.get("waitingIndex")
            try:
                if waiting_index in (0, 1):
                    return int(waiting_index)
            except Exception:
                pass
            stage_label = str(status.get("pendingStageRaw") or status.get("currentStageRaw") or status.get("currentStage") or self.current_stage or "")
        else:
            stage_label = str(self.current_stage or "")
        return 0 if self.next_time_stage_index(stage_label) == 1 else 1

    def handle_limit_wait_check(self, payload):
        if not isinstance(payload, dict):
            return
        if self.config.get("switchMode", "time") == "time":
            return
        stage_label = str(payload.get("stageLabel") or "")
        waiting_index = int(payload.get("waitingIndex", -1) or -1)
        key = str(payload.get("key") or "")
        with self.lock:
            self.pending_limit_ocr[key] = {
                "stageLabel": stage_label,
                "waitingIndex": waiting_index,
                "createdAt": time.time(),
                "resumeAfter": 0.0,
            }

    def handle_limit_wait_timeout(self, payload):
        if not isinstance(payload, dict):
            return
        if self.config.get("switchMode", "time") == "time":
            return
        try:
            status = self.get_script_status() if self.script else {}
            if isinstance(status, dict) and status.get("monitorHold") is True:
                self.add_log("[循环] 当前掉落列表仍有监控物品，卡死保护不执行下一关点击")
                return
        except Exception:
            pass
        stage_label = str(payload.get("stageLabel") or "")
        waiting_index = int(payload.get("waitingIndex", -1) or -1)
        key = str(payload.get("key") or "")
        with self.lock:
            pending = self.pending_limit_ocr.get(key)
            if isinstance(pending, dict):
                resume_after = float(pending.get("resumeAfter") or 0.0)
                if resume_after > time.time():
                    return
            pending = self.pending_limit_ocr.pop(key, None)
        if pending is None:
            return
        current_index = 0 if waiting_index not in (0, 1) else int(waiting_index)
        next_index = 1 if current_index == 0 else 0
        self.add_log(f"[循环] 5 秒未识别到限制，改为点击{'高等级' if next_index == 1 else '低等级'}箱子关卡")
        self.enqueue_host_command(
            "press",
            [next_index],
            f"[循环] 主流程已发送点击{'高等级' if next_index == 1 else '低等级'}箱子关卡指令",
        )

    def box_level_from_item_id(self, item_id):
        sid = re.sub(r"\D+", "", str(item_id or ""))
        if len(sid) < 3:
            return 0
        try:
            suffix = int(sid[-3:])
        except Exception:
            return 0
        if suffix >= 10 and suffix % 10 == 1:
            return suffix // 10
        return suffix

    def stage_label_from_item_ids(self, item_ids):
        levels = []
        for item_id in item_ids or []:
            level = self.box_level_from_item_id(item_id)
            if level > 0:
                levels.append(level)
        if not levels:
            return ""
        return f"LV{max(levels)}"

    def update_loop_state_from_text(self, text):
        if not text:
            return
        text = str(text)
        if "[录制] #7" in text:
            self.ready_done = True
            self.running = False
            self.auto_started = False
        elif "[循环] 开始" in text:
            self.ready_done = True
            self.running = True
            self.auto_started = True
        elif "[循环] 已停止" in text:
            self.running = False
            self.auto_started = False


    def find_taskbarhero_pids(self):
        pids = []
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                if (proc.info.get("name") or "").lower() == PROCESS_NAME.lower():
                    pids.append(proc.info["pid"])
            except Exception:
                pass
        return sorted(pids)

    def trim_taskbarhero_memory_once(self, quiet=False):
        try:
            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi
            kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
            kernel32.OpenProcess.restype = ctypes.c_void_p
            kernel32.SetProcessWorkingSetSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
            kernel32.SetProcessWorkingSetSize.restype = ctypes.c_bool
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle.restype = ctypes.c_bool
            psapi.EmptyWorkingSet.argtypes = [ctypes.c_void_p]
            psapi.EmptyWorkingSet.restype = ctypes.c_bool
            process_set_quota = 0x0100
            process_query_limited_information = 0x1000
            current = 0
            freed = 0
            count = 0
            failed = 0
            trimmed = []
            for proc in psutil.process_iter(["pid", "name", "memory_info"]):
                try:
                    if (proc.info.get("name") or "").lower() != PROCESS_NAME.lower():
                        continue
                    before = int(proc.info["memory_info"].rss)
                    handle = kernel32.OpenProcess(process_set_quota | process_query_limited_information, False, int(proc.info["pid"]))
                    if handle:
                        try:
                            ok_empty = psapi.EmptyWorkingSet(handle)
                            ok_trim = kernel32.SetProcessWorkingSetSize(handle, ctypes.c_size_t(-1).value, ctypes.c_size_t(-1).value)
                            if ok_empty or ok_trim:
                                trimmed.append((int(proc.info["pid"]), before))
                            else:
                                failed += 1
                        finally:
                            kernel32.CloseHandle(handle)
                    else:
                        failed += 1
                except Exception:
                    failed += 1
                    continue
            if trimmed:
                time.sleep(0.5)
            for pid, before in trimmed:
                try:
                    proc_obj = psutil.Process(pid)
                    after = int(proc_obj.memory_info().rss)
                    current += after
                    freed += max(0, before - after)
                    count += 1
                except Exception:
                    continue
            if count and not quiet:
                fail_text = f"，失败 {failed} 个" if failed else ""
                self.add_log(f"[内存] 已优化 {count} 个游戏进程{fail_text}，当前 {current / 1024 / 1024:.1f} MB，释放 {freed / 1024 / 1024:.1f} MB")
            elif failed and not quiet:
                self.add_log(f"[内存] 优化失败：无法修剪 {failed} 个游戏进程，可能需要管理员权限")
        except Exception as exc:
            if not quiet:
                self.add_log(f"[内存] 优化失败：{sunny_error_cn(exc)}")

    def start_memory_trim_worker(self):
        if self.memory_trim_thread and self.memory_trim_thread.is_alive():
            return
        self.memory_trim_stop.clear()

        def worker():
            try:
                self.trim_taskbarhero_memory_once()
            except Exception:
                write_debug_log("memory trim initial run failed:\n" + traceback.format_exc())
            while not self.memory_trim_stop.wait(MEMORY_TRIM_INTERVAL_SECONDS):
                try:
                    self.trim_taskbarhero_memory_once(quiet=True)
                except Exception:
                    write_debug_log("memory trim worker failed:\n" + traceback.format_exc())

        self.memory_trim_thread = threading.Thread(target=worker, daemon=True)
        self.memory_trim_thread.start()

    def stop_memory_trim_worker(self):
        self.memory_trim_stop.set()

    def refresh_record_status_once(self):
        script_status = self.get_script_status()
        current_recorded = script_status.get("recorded", [])
        if not isinstance(current_recorded, list):
            current_recorded = []
        set_recorded = script_status.get("recordSets", {}).get("time", []) if isinstance(script_status.get("recordSets"), dict) else []
        if not isinstance(set_recorded, list):
            set_recorded = []
        recording_index = script_status.get("recordingIndex", None)
        with self.lock:
            self.script_status_cache = dict(script_status or {})
            old_rows = self.recorded_buttons_cache.get("time") or []
            recorded_buttons = self.merge_recorded_button_rows(current_recorded, set_recorded)
            recorded_buttons = self.merge_recorded_button_rows(recorded_buttons, old_rows)
            if recorded_buttons:
                self.recorded_buttons_cache["time"] = recorded_buttons
            cached_index = self.recording_index_cache
            if recording_index is None and isinstance(cached_index, int):
                rows = self.recorded_buttons_cache.get("time") or []
                row = rows[cached_index] if cached_index < len(rows) else None
                if isinstance(row, dict) and row.get("ptr"):
                    self.recording_index_cache = None
                else:
                    recording_index = cached_index
            elif recording_index is not None:
                self.recording_index_cache = int(recording_index)

    def start_record_status_worker(self):
        if self.record_status_thread and self.record_status_thread.is_alive():
            return
        self.record_status_stop.clear()

        def worker():
            while not self.record_status_stop.wait(self.record_status_poll_interval()):
                if not self.script:
                    continue
                try:
                    self.refresh_record_status_once()
                except Exception as exc:
                    write_debug_log(f"record status worker failed: {sunny_error_cn(exc)}")

        self.record_status_thread = threading.Thread(target=worker, daemon=True)
        self.record_status_thread.start()

    def record_status_poll_interval(self):
        with self.lock:
            recording = isinstance(self.recording_index_cache, int)
            status = dict(self.script_status_cache or {})
        if recording:
            return 0.25
        cross = status.get("crossLoop") if isinstance(status.get("crossLoop"), dict) else {}
        auto_deposit = status.get("autoDeposit") if isinstance(status.get("autoDeposit"), dict) else {}
        if bool(status.get("running")) or bool(cross.get("running")) or bool(auto_deposit.get("running")):
            return 2.0
        return 6.0

    def stop_record_status_worker(self):
        self.record_status_stop.set()

    def capture_taskbarhero_window(self):
        try:
            hwnd = 0
            for pid in self.find_taskbarhero_pids():
                hwnds = hwnds_for_pid(pid)
                if hwnds:
                    hwnd = int(hwnds[0])
                    break
            if not hwnd:
                return None, 0, None
            rect = window_rect(hwnd)
            if not rect:
                return None, hwnd, None
            image = print_window_capture(hwnd)
            return image, hwnd, rect
        except Exception:
            write_debug_log("capture_taskbarhero_window failed:\n" + traceback.format_exc())
            return None, 0, None

    def ocr_service_request(self, path, payload=None, timeout=10):
        if path == "/init":
            url = DEFAULT_UMI_HTTP_URL.rstrip("/") + "/api/ocr/get_options"
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "TBH-Drop-OCR/1.0", "Accept": "application/json"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return {"ok": True, "ready": True, "message": "初始化成功", "options": json.loads(raw.decode("utf-8", errors="replace") or "{}")}

        if path == "/ocr":
            image_payload = (payload or {}).get("image")
            image_pil = self.decode_pil_image_for_umi(image_payload)
            image_base64 = self.image_pil_to_png_base64(image_pil)
            request_body = {
                "base64": image_base64,
                "options": {
                    "tbpu.parser": "single_line",
                    "data.format": "text",
                },
            }
            url = DEFAULT_UMI_HTTP_URL.rstrip("/") + "/api/ocr"
            req = urllib.request.Request(
                url,
                data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
                headers={
                    "User-Agent": "TBH-Drop-OCR/1.0",
                    "Accept": "application/json",
                    "Content-Type": "application/json; charset=utf-8",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                if not raw:
                    raise
            result = json.loads(raw.decode("utf-8", errors="replace") or "{}")
            code = int(result.get("code", 0) or 0)
            if code == 100:
                return {
                    "ok": True,
                    "message": "ok",
                    "text": str(result.get("data") or ""),
                    "score": float(result.get("score", 0.0) or 0.0),
                    "elapsedMs": float(result.get("elapsedMs", 0.0) or 0.0),
                }
            if code == 101:
                return {"ok": True, "message": "ok", "text": "", "score": float(result.get("score", 0.0) or 0.0), "elapsedMs": 0.0}
            return {"ok": False, "message": str(result.get("data") or result), "text": "", "score": 0.0, "elapsedMs": 0.0}

        raise RuntimeError(f"不支持的 OCR 接口：{path}")

    def try_ocr_service_init(self, timeout=8):
        try:
            result = self.ocr_service_request("/init", timeout=timeout)
            if result.get("ok"):
                return True, "初始化成功"
            return False, str(result.get("message") or "OCR 初始化失败")
        except Exception as exc:
            return False, sunny_error_cn(exc)

    def ensure_ocr_service_ready(self):
        try:
            ok, message = self.try_ocr_service_init(timeout=8)
            if ok:
                return True, message
            return False, f"{message}，请先确认 Umi-OCR 已启动并开启 HTTP 服务：{DEFAULT_UMI_HTTP_URL}"
        except Exception as exc:
            write_debug_log("ensure_ocr_service_ready failed:\n" + traceback.format_exc())
            return False, "OCR 初始化失败：" + sunny_error_cn(exc)

    def ensure_paddle_small_rec_ocr(self):
        ok, message = self.ensure_ocr_service_ready()
        if not ok:
            self.paddle_small_rec_init_error = message
            self.ocr_ready = False
            return None
        self.paddle_small_rec_init_error = ""
        self.ocr_ready = True
        return True

    def decode_pil_image_for_umi(self, image):
        raw, width, height, channels = bgra_image_to_bgra_bytes(image)
        if raw is None or channels != 4:
            raise ValueError("图片数据无效")
        rgba = bytearray()
        for i in range(0, len(raw), 4):
            b = raw[i]
            g = raw[i + 1]
            r = raw[i + 2]
            a = raw[i + 3]
            rgba.extend((r, g, b, a))
        return Image.frombytes("RGBA", (width, height), bytes(rgba)).convert("RGB")

    def image_pil_to_png_base64(self, image_pil):
        if image_pil is None:
            raise ValueError("图片为空")
        buffer = io.BytesIO()
        image_pil.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    def parse_notice_item_name(self, text):
        compact = "".join(str(text or "").split())
        if not compact:
            return "", "", "", ""
        compact = compact.replace("获得丁", "获得了").replace("荻得了", "获得了").replace("荻得", "获得")
        compact = compact.replace("（", "(").replace("）", ")")
        compact = compact.replace("【", "[").replace("】", "]")
        compact = compact.replace("r0", "[0").replace("r1", "[1").replace("r2", "[2")
        compact = compact.replace("r3", "[3").replace("r4", "[4").replace("r5", "[5")
        compact = compact.replace("r6", "[6").replace("r7", "[7").replace("r8", "[8").replace("r9", "[9")
        compact = re.sub(
            r"\[([0-9OIl]{2}):([0-9OIl])\]?(?![0-9OIl])",
            lambda m: "[" + m.group(1).replace("O", "0").replace("I", "1").replace("l", "1") + ":0" + m.group(2).replace("O", "0").replace("I", "1").replace("l", "1") + "]",
            compact,
        )
        compact = re.sub(
            r"([\)\]])([0-9OIl]{2}):([0-9OIl])\]?$",
            lambda m: m.group(1) + "[" + m.group(2).replace("O", "0").replace("I", "1").replace("l", "1") + ":0" + m.group(3).replace("O", "0").replace("I", "1").replace("l", "1") + "]",
            compact,
        )
        compact = re.sub(
            r"([\)\]])([0-9OIl]{4})\]?$",
            lambda m: m.group(1) + "[" + m.group(2).replace("O", "0").replace("I", "1").replace("l", "1")[:2] + ":" + m.group(2).replace("O", "0").replace("I", "1").replace("l", "1")[2:4] + "]",
            compact,
        )
        compact = re.sub(
            r"([\)\]])[:：]([0-9OIl]{2}:[0-9OIl]{2})\]?$",
            lambda m: m.group(1) + "[" + m.group(2).replace("O", "0").replace("I", "1").replace("l", "1") + "]",
            compact,
        )
        compact = re.sub(r"(?<!\[)(\d{2}:\d{2})(?!\])", r"[\1]", compact)
        compact = re.sub(r"[\[\(]([0-9OIl]{2}:[0-9OIl]{2})[\]\)]", lambda m: "[" + m.group(1).replace("O", "0").replace("I", "1").replace("l", "1") + "]", compact)
        compact = compact.replace(")r", ")[")
        compact = re.sub(r"\[([0-9]{2}:[0-9]{2})\)+$", r"[\1]", compact)
        compact = re.sub(r"\)+\[([0-9]{2}:[0-9]{2})\]$", r")[\1]", compact)

        def strip_trailing_broken_time(value):
            raw = str(value or "")
            raw = re.sub(r"[0-9OIl]{3,4}$", "", raw)
            return raw.rstrip("([")

        m = re.search(r"(获得[了]?.+?\[\d{2}:\d{2}\]?)", compact)
        full_text = m.group(1).strip() if m else compact
        broken_tm = re.search(r"\[(\d{2}:\d{2})$", full_text)
        if broken_tm and not re.search(r"\[\d{2}:\d{2}\]", full_text):
            full_text = full_text + "]"
        if not re.search(r"\[\d{2}:\d{2}\]", full_text):
            full_text = strip_trailing_broken_time(full_text)
        tm = re.search(r"\[(\d{2}:\d{2})\]", full_text)
        time_key = tm.group(1) if tm else ""
        box_kind = ""
        is_box_notice = False
        if "普通宝箱" in full_text:
            box_kind = "普通"
            is_box_notice = True
        elif "关卡宝箱" in full_text:
            box_kind = "首领"
            is_box_notice = True
        if is_box_notice:
            box_name = ""
            box_match = re.search(r"宝箱\((.*?)\)", full_text)
            if box_match:
                box_name = box_match.group(1).strip()
            return full_text, box_name, time_key, box_kind
        n = re.search(r"获得[了]?(.+?)\[\d{2}:\d{2}\]", full_text)
        if not n:
            n = re.search(r"获得[了]?(.+)", full_text)
        if not n:
            return full_text, "", time_key, box_kind
        return full_text, n.group(1).strip(), time_key, box_kind

    def current_beijing_hhmm(self):
        return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%H:%M")

    def notice_box_compare_signature(self, raw_text, box_kind="", time_key="", item_name=""):
        text = str(raw_text or "").strip()
        kind = "首领" if str(box_kind or "").strip() == "首领" else ("普通" if str(box_kind or "").strip() == "普通" else "")
        if not text or not kind:
            return ""
        text = re.sub(r"\[[^\]]*\]", "", text)
        text = re.sub(r"\([^\)]*\)", "", text)
        text = text.replace("（", "(").replace("）", ")")
        if "关卡宝箱" in text:
            label = "关卡宝箱"
        elif "普通宝箱" in text:
            label = "普通宝箱"
        else:
            label = kind + "宝箱"
        parsed_name = str(item_name or "").strip()
        if not parsed_name:
            name_match = re.search(r"宝箱\((.*?)\)", str(raw_text or ""))
            if name_match:
                parsed_name = name_match.group(1).strip()
        return "|".join([
            label,
            parsed_name,
            str(time_key or "").strip(),
        ])

    def notice_box_signature(self, raw_text, box_kind="", time_key="", item_name="", detected_at=""):
        compare_signature = self.notice_box_compare_signature(raw_text, box_kind, time_key, item_name)
        if not compare_signature:
            return ""
        return compare_signature + "|" + str(detected_at or "").strip()

    def notice_box_min_delete_interval_seconds(self, box_kind=""):
        return 8 * 60 if str(box_kind or "").strip() == "首领" else 3 * 60

    def notice_box_interval_key(self, box_kind="", time_key="", item_name=""):
        return "|".join([
            "首领" if str(box_kind or "").strip() == "首领" else "普通",
            str(item_name or "").strip(),
            str(time_key or "").strip(),
        ])

    def normalize_notice_time_loose(self, time_key=""):
        raw = str(time_key or "").strip()
        if not raw:
            return ""
        raw = raw.replace("O", "0").replace("I", "1").replace("l", "1").replace("：", ":")
        raw = raw.replace("[", "").replace("]", "").replace("(", "").replace(")", "")
        m = re.search(r"(\d{2}):?(\d{2})", raw)
        if not m:
            return ""
        hh = int(m.group(1))
        mm = int(m.group(2))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return f"{hh:02d}:{mm:02d}"
        return ""

    def notice_box_components(self, raw_text, box_kind="", time_key="", item_name=""):
        text = str(raw_text or "").strip()
        kind = "首领" if str(box_kind or "").strip() == "首领" else ("普通" if str(box_kind or "").strip() == "普通" else "")
        label = ""
        if "关卡宝箱" in text or kind == "首领":
            label = "关卡宝箱"
        elif "普通宝箱" in text or kind == "普通":
            label = "普通宝箱"
        name = self.normalized_notice_name(item_name)
        if not name:
            m = re.search(r"宝箱\((.*?)\)", text.replace("（", "(").replace("）", ")"))
            if m:
                name = self.normalized_notice_name(m.group(1))
        loose_time = self.normalize_notice_time_loose(time_key)
        if not loose_time:
            m = re.search(r"(\d{2}:\d{2})", text.replace("：", ":"))
            if m:
                loose_time = self.normalize_notice_time_loose(m.group(1))
        return {
            "label": label,
            "name": name,
            "time": loose_time,
        }

    def notice_box_component_match_count(self, left, right):
        if not isinstance(left, dict) or not isinstance(right, dict):
            return 0
        count = 0
        if left.get("label") and left.get("label") == right.get("label"):
            count += 1
        if left.get("name") and left.get("name") == right.get("name"):
            count += 1
        if left.get("time") and left.get("time") == right.get("time"):
            count += 1
        return count

    def score_notice_ocr_candidate(self, raw_text="", item_name="", time_key="", box_kind=""):
        score = 0.0
        text = str(raw_text or "").strip()
        item_name = str(item_name or "").strip()
        time_key = self.normalize_notice_time_loose(time_key)
        kind = str(box_kind or "").strip()
        if text:
            score += min(len(text), 40) * 0.1
        if kind in ("普通", "首领"):
            score += 15.0
        if item_name:
            score += min(len(item_name), 12) * 1.5
        if time_key:
            score += 20.0
        if "获得了" in text:
            score += 5.0
        if "宝箱" in text:
            score += 5.0
        if re.search(r"\[\d{2}:\d{2}\]", text):
            score += 8.0
        if "(" in text and ")" in text:
            score += 4.0
        return score

    def rerun_notice_ocr_best_of_ten(self, image, first_result):
        candidates = []
        first_raw, first_name, first_time, first_kind = first_result
        if first_raw and first_kind in ("普通", "首领"):
            candidates.append((first_raw, first_name, first_time, first_kind))
        for idx in range(9):
            try:
                candidate = self.run_notice_ocr_without_debug(image)
            except Exception:
                write_debug_log("rerun_notice_ocr_best_of_ten failed:\n" + traceback.format_exc())
                continue
            raw_text, item_name, time_key, box_kind = candidate
            if raw_text and box_kind in ("普通", "首领"):
                candidates.append(candidate)
            else:
                write_debug_log(f"[OCR结果] rerun#{idx + 2} ignored={candidate}")
        if not candidates:
            return first_result
        best = max(candidates, key=lambda row: self.score_notice_ocr_candidate(row[0], row[1], row[2], row[3]))
        write_debug_log(
            f"[OCR结果] rerun best-of-{len(candidates)} score={self.score_notice_ocr_candidate(best[0], best[1], best[2], best[3]):.1f} best={best}"
        )
        return best

    def remember_recent_notice_delete(self, raw_text, box_kind="", time_key="", item_name=""):
        entry = {
            "at": time.monotonic(),
            "boxKind": "首领" if str(box_kind or "").strip() == "首领" else "普通",
            "raw": str(raw_text or "").strip(),
            "components": self.notice_box_components(raw_text, box_kind, time_key, item_name),
        }
        with self.lock:
            items = list(getattr(self, "notice_box_recent_deletes", []) or [])
            items.append(entry)
            cutoff = entry["at"] - 8 * 60
            items = [x for x in items if float(x.get("at", 0.0) or 0.0) >= cutoff]
            self.notice_box_recent_deletes = items

    def should_suppress_notice_variant(self, raw_text, box_kind="", time_key="", item_name=""):
        raw_text = str(raw_text or "").strip()
        if not raw_text:
            return False
        now_mono = time.monotonic()
        current = self.notice_box_components(raw_text, box_kind, time_key, item_name)
        kind = "首领" if str(box_kind or "").strip() == "首领" else "普通"
        full_signature = self.notice_box_signature(raw_text, kind, time_key, item_name, str(time_key or "").strip())
        with self.lock:
            suppressed = dict(getattr(self, "notice_box_suppressed_variants", {}) or {})
            suppress_at = float(suppressed.get(full_signature, 0.0) or 0.0)
            min_interval = float(self.notice_box_min_delete_interval_seconds(kind))
            if suppress_at > 0 and now_mono - suppress_at < min_interval:
                write_debug_log(f"[OCR结果] suppressed variant hit: raw={raw_text}")
                return True
            recent_deletes = list(getattr(self, "notice_box_recent_deletes", []) or [])
        for entry in recent_deletes:
            if str(entry.get("boxKind") or "") != kind:
                continue
            deleted_at = float(entry.get("at", 0.0) or 0.0)
            if now_mono - deleted_at > float(self.notice_box_min_delete_interval_seconds(kind)):
                continue
            components = entry.get("components") or {}
            if self.notice_box_component_match_count(current, components) >= 2:
                with self.lock:
                    suppressed = dict(getattr(self, "notice_box_suppressed_variants", {}) or {})
                    suppressed[full_signature] = now_mono
                    self.notice_box_suppressed_variants = suppressed
                write_debug_log(f"[OCR结果] suppressed variant stored: raw={raw_text} matched_deleted={entry.get('raw')}")
                return True
        return False

    def initialize_notice_box_baseline(self, raw_text, box_kind, time_key, item_name=""):
        compare_signature = self.notice_box_compare_signature(raw_text, box_kind, time_key, item_name)
        if not compare_signature:
            return False
        detected_at = str(time_key or "").strip()
        full_signature = self.notice_box_signature(raw_text, box_kind, time_key, item_name, detected_at)
        with self.lock:
            self.notice_box_baseline_signature = compare_signature
            self.notice_box_baseline_time_key = detected_at
            self.notice_box_baseline_full_signature = full_signature
            self.last_notice_box_signature = compare_signature
        self.add_log(
            f"[OCR] 初始化基准：{compare_signature}|{detected_at}",
            frontend=False,
        )
        return True

    def initialize_notice_box_baseline_once(self):
        try:
            image, _hwnd, _rect = self.capture_taskbarhero_window()
            if image is None:
                write_debug_log("[OCR结果] init baseline capture failed")
                return False
            raw_text, item_name, time_key, box_kind = self.run_notice_ocr_once(image)
            if raw_text and box_kind in ("普通", "首领"):
                return self.initialize_notice_box_baseline(raw_text, box_kind, time_key, item_name)
            if raw_text:
                write_debug_log(f"[OCR结果] init baseline skip: raw={raw_text}")
            return False
        except Exception:
            write_debug_log("initialize notice baseline failed:\n" + traceback.format_exc())
            return False

    def run_notice_ocr_once(self, image):
        if image is None:
            return "", "", "", ""
        ok, message = self.ensure_ocr_service_ready()
        if not ok:
            self.paddle_small_rec_init_error = message
            self.ocr_ready = False
            now = time.monotonic()
            if now - float(self.last_ocr_service_error_log_at or 0) >= 10.0:
                self.last_ocr_service_error_log_at = now
                self.add_log("[OCR] 初始化失败：" + str(message))
            return "", "", "", ""
        self.ocr_ready = True
        if is_packaged_app():
            return self.run_notice_ocr_without_debug(image)
        try:
            debug_dir = APP_DIR / "output" / "ocr_debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            ts = "latest"
            save_bgra_bmp(image, debug_dir / f"{ts}_full.bmp")
            rect = self.notice_rect_for_runtime_image(image)
            if rect:
                crop = crop_bgra_image(image, rect)
                if crop:
                    save_bgra_bmp(crop, debug_dir / f"{ts}_crop.bmp")
                    write_debug_log(f"[OCR调试] rect={rect} full={debug_dir / f'{ts}_full.bmp'} crop={debug_dir / f'{ts}_crop.bmp'}")
        except Exception:
            write_debug_log("save ocr debug image failed:\n" + traceback.format_exc())
        return self.run_notice_ocr_without_debug(image)

    def run_notice_ocr_without_debug(self, image):
        try:
            rect = self.notice_rect_for_runtime_image(image)
            crop = crop_bgra_image(image, rect) if rect else None
            payload = {"image": crop}
            if not payload["image"]:
                return "", "", "", ""
            result = self.ocr_service_request("/ocr", payload, timeout=8)
        except Exception as exc:
            write_debug_log("[OCR结果] request failed: " + sunny_error_cn(exc))
            write_debug_log("notice ocr request failed:\n" + traceback.format_exc())
            return "", "", "", ""
        text = str(result.get("text") or "").strip() if result.get("ok") else ""
        write_debug_log(f"[OCR结果] raw={text or '<empty>'}")
        if not result.get("ok"):
            write_debug_log(f"[OCR结果] error={result.get('message') or 'unknown error'}")
        parsed = self.parse_notice_item_name(text)
        if crop and parsed[0] and parsed[3] in ("普通", "首领") and not parsed[2]:
            try:
                time_rect = notice_time_rect_for_crop(crop)
                time_crop = crop_bgra_image(crop, time_rect) if time_rect else None
                if time_crop:
                    if not is_packaged_app():
                        try:
                            debug_dir = APP_DIR / "output" / "ocr_debug"
                            debug_dir.mkdir(parents=True, exist_ok=True)
                            save_bgra_bmp(time_crop, debug_dir / "latest_time_crop.bmp")
                            write_debug_log(f"[OCR调试] time_crop={debug_dir / 'latest_time_crop.bmp'}")
                        except Exception:
                            write_debug_log("save notice time crop failed:\n" + traceback.format_exc())
                    time_result = self.ocr_service_request("/ocr", {"image": time_crop}, timeout=8)
                    time_text = "".join(str(time_result.get("text") or "").split()) if time_result.get("ok") else ""
                    write_debug_log(f"[OCR结果] time_raw={time_text or '<empty>'}")
                    tm = re.search(r"([0-9OIl]{2}:[0-9OIl]{2}|[0-9OIl]{2}:[0-9OIl]|[0-9OIl]{4}|[0-9OIl]{3})", time_text)
                    if tm:
                        fixed_time = tm.group(1).replace("O", "0").replace("I", "1").replace("l", "1")
                        if re.fullmatch(r"[0-9]{4}", fixed_time):
                            fixed_time = fixed_time[:2] + ":" + fixed_time[2:4]
                        elif re.fullmatch(r"[0-9]{3}", fixed_time):
                            fixed_time = fixed_time[:2] + ":0" + fixed_time[2:3]
                        elif re.fullmatch(r"[0-9]{2}:[0-9]", fixed_time):
                            fixed_time = fixed_time[:3] + "0" + fixed_time[3:]
                        text_for_retry = str(parsed[0] or text or "").strip()
                        if fixed_time and not re.search(r"\[\d{2}:\d{2}\]", text_for_retry):
                            text_for_retry = re.sub(r"[:：]?[0-9OIl]{0,4}\]?$", "", text_for_retry).rstrip(":[")
                            text_for_retry = text_for_retry + f"[{fixed_time}]"
                            write_debug_log(f"[OCR结果] retry_with_time={text_for_retry}")
                            parsed = self.parse_notice_item_name(text_for_retry)
            except Exception as exc:
                write_debug_log("[OCR结果] time crop request failed: " + sunny_error_cn(exc))
        write_debug_log(f"[OCR结果] parsed={parsed}")
        return parsed

    def notice_rect_for_runtime_image(self, image):
        with self.lock:
            rel = (
                float(self.config.get("noticeRectLeftRel", DEFAULT_NOTICE_RELATIVE_RECT[0])),
                float(self.config.get("noticeRectTopRel", DEFAULT_NOTICE_RELATIVE_RECT[1])),
                float(self.config.get("noticeRectRightRel", DEFAULT_NOTICE_RELATIVE_RECT[2])),
                float(self.config.get("noticeRectBottomRel", DEFAULT_NOTICE_RELATIVE_RECT[3])),
            )
        return relative_notice_rect_for_image(image, rel)

    def run_limit_notice_ocr(self, image):
        if image is None:
            return ""
        ok, message = self.ensure_ocr_service_ready()
        if not ok:
            self.paddle_small_rec_init_error = message
            self.ocr_ready = False
            return ""
        self.ocr_ready = True
        rect = limit_notice_rect_for_image(image)
        if not rect:
            return ""
        crop = crop_bgra_image(image, rect)
        if not crop:
            return ""
        if not is_packaged_app():
            try:
                debug_dir = APP_DIR / "output" / "ocr_debug"
                debug_dir.mkdir(parents=True, exist_ok=True)
                save_bgra_bmp(image, debug_dir / "limit_full.bmp")
                save_bgra_bmp(crop, debug_dir / "limit_crop.bmp")
                write_debug_log(f"[限制OCR调试] rect={rect} full={debug_dir / 'limit_full.bmp'} crop={debug_dir / 'limit_crop.bmp'}")
            except Exception:
                write_debug_log("save limit ocr debug image failed:\n" + traceback.format_exc())
        extra_texts = []
        try:
            crop_width = int(crop.get("width") or 0)
            crop_height = int(crop.get("height") or 0)
            if crop_width > 0 and crop_height > 8:
                top_half = crop_bgra_image(crop, (0, 0, crop_width, max(1, int(round(crop_height * 0.58)))))
                top_center = crop_bgra_image(
                    crop,
                    (
                        int(round(crop_width * 0.08)),
                        0,
                        int(round(crop_width * 0.92)),
                        max(1, int(round(crop_height * 0.58))),
                    ),
                )
                for name, part in (("top", top_half), ("top_center", top_center)):
                    if not part:
                        continue
                    try:
                        result = self.ocr_service_request("/ocr", {"image": part}, timeout=20)
                        part_text = "".join(str(result.get("text") or "").split()) if result.get("ok") else ""
                        if part_text:
                            extra_texts.append(part_text)
                            write_debug_log(f"[限制OCR] {name}={part_text}")
                    except Exception as exc:
                        write_debug_log(f"[限制OCR] {name} request failed: " + sunny_error_cn(exc))
        except Exception:
            write_debug_log("limit split ocr failed:\n" + traceback.format_exc())
        try:
            result = self.ocr_service_request("/ocr", {"image": crop}, timeout=20)
        except Exception as exc:
            write_debug_log("[限制OCR] request failed: " + sunny_error_cn(exc))
            return ""
        text = "".join(str(result.get("text") or "").split()) if result.get("ok") else ""
        merged_text = " ".join([x for x in [text] + extra_texts if x]).strip()
        if is_limit_notice_text(merged_text):
            text = OCR_LIMIT_TEXT
        write_debug_log(f"[限制OCR] raw={text or '<empty>'}")
        return text

    def sync_time_with_beijing(self, quiet=False):
        try:
            beijing = fetch_beijing_time(timeout=0.8)
            set_local_time_to_beijing(beijing)
            if not quiet:
                self.add_log("本机时间已同步北京时间")
            return True
        except Exception as exc:
            if not quiet:
                self.add_log("同步北京时间失败：" + sunny_error_cn(exc))
            return False

    def sync_time_if_shifted(self, quiet=True):
        with self.lock:
            should_sync = bool(self.system_time_shifted)
        if not should_sync:
            return False
        ok = self.sync_time_with_beijing(quiet=quiet)
        if ok:
            with self.lock:
                self.system_time_shifted = False
        return ok

    def remove_first_drop_item_if_name_matches(self, item_name, raw_text, time_key="", box_kind=""):
        item_name = str(item_name or "").strip()
        raw_text = str(raw_text or "").strip()
        time_key = str(time_key or "").strip()
        box_kind = str(box_kind or "").strip()
        if not item_name or not raw_text:
            return False
        pending_token = ""
        pending_time_key = ""
        now = time.monotonic()
        with self.lock:
            if not box_kind:
                pending_kind = str(getattr(self, "pending_box_notice_kind", "") or "").strip()
                pending_time = str(getattr(self, "pending_box_notice_time_key", "") or "").strip()
                if pending_kind and (not time_key or not pending_time or pending_time == time_key):
                    box_kind = pending_kind
                elif bool(getattr(self, "runtime_auto_open_enabled", False)):
                    if self.last_auto_open_box_kind and time.monotonic() - float(self.last_auto_open_box_at or 0) < 20.0:
                        box_kind = self.last_auto_open_box_kind
            pending_time_key = str(getattr(self, "auto_open_pending_delete_time_key", "") or "").strip()
            pending_token = str(getattr(self, "auto_open_pending_delete_token", "") or "").strip()
        if box_kind not in ("普通", "首领"):
            return False
        effective_time_key = time_key
        if not effective_time_key and self.has_auto_open_pending_delete():
            effective_time_key = pending_time_key or pending_token
        if not effective_time_key and not self.has_auto_open_pending_delete():
            write_debug_log(f"[OCR结果] skip item notice without time: raw={raw_text}")
            return False
        recent_key = box_kind + "|" + (effective_time_key or raw_text) + "|" + self.normalized_notice_name(item_name)
        with self.lock:
            if recent_key in self.ocr_recent_text:
                return False
            unique_key = self.notice_delete_unique_key("item", box_kind, effective_time_key or raw_text, "")
            if unique_key in (self.monitor_hold_delete_keys or set()):
                self.ocr_recent_text[recent_key] = now
                return False
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            target_queue = None
            target_row = None
            for queue in queues:
                queue_is_boss = queue.get("eboxType") == 1
                if box_kind == "首领" and not queue_is_boss:
                    continue
                if box_kind == "普通" and queue_is_boss:
                    continue
                items = queue.get("items", []) or []
                if not items:
                    continue
                first = items[0] or {}
                first_name = str(first.get("name") or "").strip()
                if self.match_notice_item_to_expected(item_name, first):
                    target_queue = queue
                    target_row = dict(first)
                    break
            if target_queue is None or target_row is None:
                return False
            items = list(target_queue.get("items", []) or [])
            if items:
                items.pop(0)
            target_queue["items"] = items
            self.ocr_recent_text[recent_key] = now
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
            self.last_auto_open_box_kind = ""
            self.last_auto_open_box_at = 0.0
            self.auto_open_pending_delete_kind = ""
            self.auto_open_pending_delete_fail_count = 0
            self.auto_open_pending_delete_time_key = ""
            self.auto_open_pending_delete_token = ""
            self.auto_open_pending_box_scan_fail_count = 0
            self.ignore_next_notice_ocr_result = False
        self.mark_monitor_hold_deleted_once(unique_key)
        self.add_log(f"{raw_text}，已删除列表框对应项目。", frontend=False)
        item = self.item_plain(target_row.get("id") or target_row.get("rewardItemId") or "")
        if target_row.get("name"):
            item["name"] = target_row.get("name")
        if target_row.get("grade"):
            item["grade"] = target_row.get("grade")
        if target_row.get("gradeKey"):
            item["gradeKey"] = target_row.get("gradeKey")
        watched = self.is_watch_item(item)
        item["watched"] = watched
        self.add_obtained_item(item)
        if watched:
            if item.get("id"):
                self.notify_frida_item_dropped(item, "OCR掉落")
            self.queue_watch_notify([item], title="监控物品已掉落", start_detection=False)
        self.stop_drop_detection_if_idle(last_item=item)
        return True

    def pop_first_drop_item_from_current_drop_list(self, box_kind=""):
        prefer_boss = "首领" in str(box_kind or "")
        removed_row = None
        normal_count = 0
        boss_count = 0
        with self.lock:
            payloads = []
            if isinstance(self.last_drop, dict):
                payloads.append(self.last_drop)
            if isinstance(self.display_drop, dict) and self.display_drop is not self.last_drop:
                payloads.append(self.display_drop)
            for payload in payloads:
                queues = payload.get("queues", []) or []
                for queue in queues:
                    if not isinstance(queue, dict):
                        continue
                    if bool(queue.get("eboxType") == 1) != prefer_boss:
                        continue
                    items = list(queue.get("items", []) or [])
                    if removed_row is None and items:
                        removed_row = dict(items[0] or {})
                    if items:
                        items.pop(0)
                    queue["items"] = items
                    break
            base_payload = self.last_drop if isinstance(self.last_drop, dict) else self.display_drop
            queues = base_payload.get("queues", []) if isinstance(base_payload, dict) else []
            for queue in queues:
                if queue.get("eboxType") == 1:
                    boss_count = len(queue.get("items", []) or [])
                elif queue.get("eboxType") == 0:
                    normal_count = len(queue.get("items", []) or [])
        if not removed_row:
            return None
        item = self.item_plain(removed_row.get("id") or removed_row.get("rewardItemId") or "")
        if removed_row.get("name"):
            item["name"] = removed_row.get("name")
        if removed_row.get("grade"):
            item["grade"] = removed_row.get("grade")
        if removed_row.get("gradeKey"):
            item["gradeKey"] = removed_row.get("gradeKey")
        item["watched"] = self.is_watch_item(item)
        self.add_log(
            f"[掉落列表] 已移除已开出项目：{item.get('name', '?')}，当前列表 普通{normal_count} / 首领{boss_count}"
        )
        return item

    def clear_auto_open_pending_delete_state(self):
        with self.lock:
            self.auto_open_pending_delete_kind = ""
            self.auto_open_pending_delete_fail_count = 0
            self.auto_open_pending_delete_time_key = ""
            self.auto_open_pending_delete_token = ""
            self.auto_open_pending_box_scan_fail_count = 0

    def mark_auto_open_pending_delete(self, box_kind, time_key="", token=""):
        kind = "首领" if "首领" in str(box_kind or "") else "普通"
        with self.lock:
            self.auto_open_pending_delete_kind = kind
            self.auto_open_pending_delete_fail_count = 0
            self.auto_open_pending_delete_time_key = str(time_key or "").strip()
            self.auto_open_pending_delete_token = str(token or "").strip()
            self.auto_open_pending_box_scan_fail_count = 0

    def has_auto_open_pending_delete(self):
        with self.lock:
            kind = str(getattr(self, "auto_open_pending_delete_kind", "") or "").strip()
            return kind in ("普通", "首领")

    def advance_auto_open_pending_delete(self):
        with self.lock:
            kind = str(getattr(self, "auto_open_pending_delete_kind", "") or "").strip()
            if kind not in ("普通", "首领"):
                return False
            self.auto_open_pending_delete_fail_count = int(getattr(self, "auto_open_pending_delete_fail_count", 0) or 0) + 1
            count = self.auto_open_pending_delete_fail_count
            time_key = str(getattr(self, "auto_open_pending_delete_time_key", "") or "").strip()
            token = str(getattr(self, "auto_open_pending_delete_token", "") or "").strip()
        self.clear_auto_open_pending_delete_state()
        with self.lock:
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
            self.last_auto_open_box_kind = ""
            self.last_auto_open_box_at = 0.0
            self.ignore_next_notice_ocr_result = False
        if count >= 5:
            self.add_log(f"[OCR] 连续5次识别未触发 hook 掉落，已清除{kind}等待状态", frontend=False)
        return True

    def handle_notice_box_text_once(self, raw_text, time_key="", box_kind="", item_name=""):
        raw_text = str(raw_text or "").strip()
        box_kind = "首领" if str(box_kind or "").strip() == "首领" else "普通"
        time_key = str(time_key or "").strip()
        detected_at = time_key
        compare_signature = self.notice_box_compare_signature(raw_text, box_kind, time_key, item_name)
        if not raw_text or not compare_signature:
            return False
        if self.should_suppress_notice_variant(raw_text, box_kind, time_key, item_name):
            return False
        full_signature = self.notice_box_signature(raw_text, box_kind, time_key, item_name, detected_at)
        recent_key = full_signature
        unique_key = self.notice_delete_unique_key("box", box_kind, time_key, str(item_name or "").strip())
        interval_key = self.notice_box_interval_key(box_kind, time_key, item_name)
        now_mono = time.monotonic()
        with self.lock:
            baseline_signature = str(getattr(self, "notice_box_baseline_signature", "") or "")
            baseline_full_signature = str(getattr(self, "notice_box_baseline_full_signature", "") or "")
            if not baseline_signature:
                self.notice_box_baseline_signature = compare_signature
                self.notice_box_baseline_time_key = detected_at
                self.notice_box_baseline_full_signature = full_signature
                self.last_notice_box_signature = compare_signature
                write_debug_log(f"[OCR结果] init baseline: raw={raw_text} signature={full_signature}")
                return False
            if baseline_full_signature and baseline_full_signature == full_signature:
                self.last_notice_box_signature = compare_signature
                self.ocr_recent_box_text[recent_key] = time.monotonic()
                return False
            previous_signature = str(getattr(self, "last_notice_box_signature", "") or "")
            if previous_signature == compare_signature:
                return False
            if unique_key in (self.monitor_hold_delete_keys or set()):
                self.last_notice_box_signature = compare_signature
                self.ocr_recent_box_text[recent_key] = now_mono
                return False
            if interval_key:
                last_delete_at = float((self.notice_box_last_delete_at or {}).get(interval_key, 0.0) or 0.0)
                min_interval = float(self.notice_box_min_delete_interval_seconds(box_kind))
                if last_delete_at > 0 and now_mono - last_delete_at < min_interval:
                    write_debug_log(f"[OCR结果] skip by min interval {box_kind}<{min_interval}s raw={raw_text}")
                    self.last_notice_box_signature = compare_signature
                    self.ocr_recent_box_text[recent_key] = now_mono
                    return False
        with self.lock:
            self.notice_box_baseline_signature = compare_signature
            self.notice_box_baseline_time_key = detected_at
            self.notice_box_baseline_full_signature = full_signature
            self.last_notice_box_signature = compare_signature
            self.ocr_recent_box_text[recent_key] = now_mono
            self.last_notice_box_raw_text = raw_text
            self.last_notice_box_kind = box_kind
            self.last_notice_box_time_key = time_key
            self.last_notice_box_item_name = str(item_name or "").strip()
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
            self.expected_notice_box_kind = ""
            self.last_auto_open_box_kind = ""
            self.last_auto_open_box_at = 0.0
            self.auto_open_pending_delete_kind = ""
            self.auto_open_pending_delete_fail_count = 0
            self.auto_open_pending_delete_time_key = ""
            self.auto_open_pending_delete_token = ""
            self.auto_open_pending_box_scan_fail_count = 0
        self.add_log(f"[OCR] 已识别：{raw_text}", frontend=False)
        return False

    def click_box_match(self, match):
        rect = match.get("rect") or (0, 0, 0, 0)
        x, y, w, h = rect
        _image, hwnd, win_rect = self.capture_taskbarhero_window()
        if not hwnd or not win_rect:
            return False, "未找到游戏窗口"
        left, top, _right, _bottom = win_rect
        target_x = int(left + x + w / 2)
        target_y = int(top + y + h / 2)
        try:
            activated = activate_window_force(hwnd)
            if not activated:
                try:
                    focus_process_window(pid_for_hwnd(hwnd))
                except Exception:
                    pass
                time.sleep(0.08)
            win32_click_screen(target_x, target_y)
            time.sleep(max(0.05, int(self.config.get("autoOpenAppearDelayMs", 300) or 300) / 1000.0))
            return True, f"已真实点击{match.get('kind', '箱子')}箱中心点 ({target_x}, {target_y})"
        except Exception as exc:
            return False, sunny_error_cn(exc)

    def handle_box_match_drop(self, match):
        if not match:
            return False
        box_kind = match.get("kind", "")
        expected_kind = ""
        time_key = ""
        with self.lock:
            expected_kind = str(getattr(self, "expected_notice_box_kind", "") or "").strip()
            time_key = str(getattr(self, "pending_box_notice_time_key", "") or "").strip()
        current_kind = "首领" if "首领" in str(box_kind) else "普通"
        if expected_kind and current_kind != expected_kind:
            return False
        auto_open_enabled = bool(getattr(self, "runtime_auto_open_enabled", False))
        if auto_open_enabled:
            ok, message = self.click_box_match(match)
            self.add_log(f"[自动开箱] {message}" if ok else f"[自动开箱] 点击失败：{message}")
            if not ok:
                return False
            self.box_scan_stop.set()
            with self.lock:
                self.last_auto_open_box_kind = "首领" if "首领" in str(box_kind) else "普通"
                self.last_auto_open_box_at = time.monotonic()
                self.auto_open_pending_box_scan_fail_count = 0
            self.mark_auto_open_pending_delete(current_kind, time_key=time_key, token=time_key or str(time.monotonic()))
        item = self.peek_first_drop_item(box_kind)
        if not item:
            if auto_open_enabled:
                self.add_log(f"[箱子找图] 识别到{box_kind or '箱子'}箱，已执行点击；当前掉落列表为空，暂不删除项目", frontend=False)
            else:
                self.add_log(f"[箱子找图] 识别到{box_kind or '箱子'}箱；当前掉落列表为空，暂不删除项目", frontend=False)
            return True
        return True

    def peek_first_drop_item(self, box_kind):
        prefer_boss = "首领" in str(box_kind)
        with self.lock:
            queues = ((self.last_drop or {}).get("queues") or []) if isinstance(self.last_drop, dict) else []
            for queue in queues:
                if not isinstance(queue, dict):
                    continue
                if bool(queue.get("eboxType") == 1) != prefer_boss:
                    continue
                items = queue.get("items") or []
                if items:
                    item = dict(items[0] or {})
                    item["watched"] = self.is_watch_item(item)
                    return item
        return None

    def start_box_scan_worker(self):
        if self.box_scan_thread and self.box_scan_thread.is_alive():
            return
        self.stop_box_scan_worker()
        self.box_scan_stop.clear()

        def scan_once():
            try:
                started = time.perf_counter()
                image, _hwnd, _rect = self.capture_taskbarhero_window()
                elapsed = time.perf_counter() - started
                if elapsed > 0.8:
                    self.add_log("[找图] 单次找图超过800ms，已跳过本次", frontend=False)
                    return False
                if image is None:
                    write_debug_log("[找图] 找图失败：截图失败")
                    return False
                expected_kind = ""
                with self.lock:
                    expected_kind = str(getattr(self, "expected_notice_box_kind", "") or "").strip()
                resolved_normal_template_path, resolved_boss_template_path = self.resolve_box_template_paths(
                    self.config.get("autoOpenNormalTemplatePath", ""),
                    self.config.get("autoOpenBossTemplatePath", ""),
                )
                result = self.ocr_service_request(
                    "/match-box",
                    {
                        "image": image,
                        "kind": "boss" if expected_kind == "首领" else ("normal" if expected_kind == "普通" else ""),
                        "normalTemplatePath": resolved_normal_template_path,
                        "bossTemplatePath": resolved_boss_template_path,
                        "threshold": BOX_MATCH_THRESHOLD,
                    },
                    timeout=12,
                )
                match = result.get("match") if result.get("ok") else None
                if match:
                    current_kind = "首领" if "首领" in str(match.get("kind", "")) else "普通"
                    if expected_kind and current_kind != expected_kind:
                        return False
                    self.add_log(f"[找图] 找到{match['kind']}箱，置信度 {match['score']:.4f}", frontend=False)
                    if self.handle_box_match_drop(match):
                        return True
                fallback_kind = ""
                fallback_time_key = ""
                fallback_token = ""
                allow_fallback_delete = False
                with self.lock:
                    fallback_kind = str(getattr(self, "expected_notice_box_kind", "") or "").strip()
                    fallback_time_key = str(getattr(self, "pending_box_notice_time_key", "") or "").strip()
                    fallback_token = str(getattr(self, "auto_open_pending_delete_token", "") or "").strip()
                    if str(getattr(self, "auto_open_pending_delete_kind", "") or "").strip() in ("普通", "首领"):
                        self.auto_open_pending_box_scan_fail_count = int(getattr(self, "auto_open_pending_box_scan_fail_count", 0) or 0) + 1
                        fail_count = self.auto_open_pending_box_scan_fail_count
                        allow_fallback_delete = True
                    else:
                        fail_count = 0
                if allow_fallback_delete and fallback_kind in ("普通", "首领") and fail_count >= 5:
                    self.add_log(f"[找图] 连续5次未找到{fallback_kind}箱，保留列表等待 hook 实际掉落", frontend=False)
                    self.clear_auto_open_pending_delete_state()
                    with self.lock:
                        self.expected_notice_box_kind = ""
                        self.pending_box_notice_kind = ""
                        self.pending_box_notice_time_key = ""
                        self.ignore_next_notice_ocr_result = False
                    self.stop_box_scan_worker()
                    return True
                return False
            except Exception:
                write_debug_log("box scan background detect failed:\n" + traceback.format_exc())
                write_debug_log("[找图] 后台找箱异常")
                return False

        def worker():
            self.add_log("[找图] 已启动后台定时找箱子", frontend=False)
            if scan_once():
                return
            while not self.box_scan_stop.is_set():
                if self.box_scan_stop.wait(5.0):
                    break
                if scan_once():
                    break

        self.box_scan_thread = threading.Thread(target=worker, daemon=True)
        self.box_scan_thread.start()

    def stop_box_scan_worker(self):
        self.box_scan_stop.set()
        thread = self.box_scan_thread
        self.box_scan_thread = None
        self.box_scan_stop.set()
        if thread and thread.is_alive():
            try:
                thread.join(timeout=0.5)
            except Exception:
                pass

    def start_notice_ocr_worker(self):
        if not self.running:
            return
        if self.ocr_scan_thread and self.ocr_scan_thread.is_alive():
            return
        self.stop_notice_ocr_worker()
        self.ocr_scan_stop.clear()
        self.add_log("[OCR] 已启动后台识别，等待实际开箱通知")

        def worker():
            self.run_notice_ocr_cycle_once()
            while not self.ocr_scan_stop.is_set():
                if self.ocr_scan_stop.wait(5.0):
                    break
                self.run_notice_ocr_cycle_once()

        self.ocr_scan_thread = threading.Thread(target=worker, daemon=True)
        self.ocr_scan_thread.start()

    def run_notice_ocr_cycle_once(self):
        try:
            image, _hwnd, _rect = self.capture_taskbarhero_window()
            if image is None:
                write_debug_log("[OCR结果] capture failed")
                return False
            raw_text, item_name, time_key, box_kind = self.run_notice_ocr_once(image)
            if raw_text and box_kind in ("普通", "首领"):
                current_compare = self.notice_box_compare_signature(raw_text, box_kind, time_key, item_name)
                with self.lock:
                    previous_compare = str(getattr(self, "last_notice_box_signature", "") or "")
                    baseline_compare = str(getattr(self, "notice_box_baseline_signature", "") or "")
                if current_compare and previous_compare and current_compare != previous_compare and current_compare != baseline_compare:
                    write_debug_log(f"[OCR结果] first-change rerun start: prev={previous_compare} current={current_compare}")
                    raw_text, item_name, time_key, box_kind = self.rerun_notice_ocr_best_of_ten(
                        image,
                        (raw_text, item_name, time_key, box_kind),
                    )
                handled = self.handle_notice_box_text_once(raw_text, time_key, box_kind, item_name)
                if handled:
                    return True
                return False
            if raw_text:
                if item_name:
                    write_debug_log(f"[OCR结果] skip non-box notice: raw={raw_text}")
                else:
                    write_debug_log(f"[OCR结果] skip unsupported notice: raw={raw_text}")
                return False
            write_debug_log("[OCR结果] no usable notice parsed")
            return False
        except Exception:
            write_debug_log("notice ocr background failed:\n" + traceback.format_exc())
            return False

    def stop_notice_ocr_worker(self):
        self.ocr_scan_stop.set()
        thread = self.ocr_scan_thread
        self.ocr_scan_thread = None
        if thread and thread.is_alive():
            try:
                thread.join(timeout=0.5)
            except Exception:
                pass

    def ensure_notice_ocr_ready(self):
        ocr = self.ensure_paddle_small_rec_ocr()
        if ocr is None:
            return False, self.paddle_small_rec_init_error or "OCR 初始化失败"
        self.add_log(f"当前直接使用 Umi-OCR HTTP 接口：{DEFAULT_UMI_HTTP_URL}")
        self.add_log("请保持 Umi-OCR 主程序和它的 HTTP 服务开启，否则会导致无法识别掉落")
        return True, "OCR 初始化完成"

    def handle_sunny_response(self, body, stage=""):
        if not body:
            return False
        try:
            outer = json.loads(body)
            inner = outer.get("result")
            data = json.loads(inner) if isinstance(inner, str) else outer
        except Exception as exc:
            self.add_log(f"网络响应解析失败：{exc}")
            write_debug_log(f"[Frida响应][解析失败] {frida_error_cn(exc)}")
            return False
        body_data = ((data or {}).get("data") or {})
        added = body_data.get("added") or []
        boxes = [
            box for box in (body_data.get("boxes") or [])
            if isinstance(box, dict) and box.get("isGet") is not True
        ]
        if not boxes:
            write_debug_log(f"[Frida响应] boxes=0 added={len(added)} stage={stage or '未知'}")
            return False
        if not stage:
            box_item_ids = {int(box.get("itemId")) for box in boxes if isinstance(box, dict) and str(box.get("itemId", "")).isdigit()}
            stage = self.stage_label_from_item_ids(box_item_ids)
        write_debug_log(f"[Frida响应] boxes={len(boxes)} added={len(added)} stage={stage or '自动识别'}")
        if stage:
            with self.lock:
                self.current_stage = stage
        normal = []
        boss = []
        for box in boxes:
            item = self.item_plain(box.get("rewardItemId"))
            item["itemKey"] = str(box.get("itemKey", ""))
            item["rewardItemKey"] = str(box.get("rewardItemKey", ""))
            if str(box.get("itemId", "")).startswith("920"):
                boss.append(item)
            else:
                normal.append(item)
        watched_items = [item for item in normal + boss if item.get("watched")]
        payload = {
            "type": "drop_update",
            "source": "网络响应",
            "currentStage": self.current_stage,
            "queues": [
                {"eboxType": 0, "label": "normal", "items": normal},
                {"eboxType": 1, "label": "boss", "items": boss},
            ],
        }
        with self.lock:
            self.last_drop = copy.deepcopy(payload)
            self.display_drop = copy.deepcopy(payload)
        visible_watched_items = [item for item in watched_items if self.visible_watch_item(item)]
        self.queue_watch_notify(visible_watched_items, stage=self.current_stage)
        self.notify_frida_network_drop(payload)
        return True

    def frida_rewrite_lists(self):
        result = {}
        source = self.response_rewrite_config or {}
        for queue_id, ids in source.items():
            cleaned = []
            if not isinstance(ids, list):
                continue
            for raw in ids:
                text = str(raw or "").strip()
                if not text:
                    continue
                try:
                    value = int(text)
                except Exception:
                    continue
                if value > 0:
                    cleaned.append(value)
            if cleaned:
                result[str(queue_id)] = cleaned
        return result

    def notify_frida_network_drop(self, payload):
        if not self.script:
            return
        payload = copy.deepcopy(payload) if isinstance(payload, dict) else {}
        progress = self.monitor_hold_progress()
        payload["monitorProgress"] = {
            "expected": int(progress.get("expected", 0) or 0),
            "deleted": int(progress.get("deleted", 0) or 0),
            "normalExpected": int(progress.get("normalExpected", 0) or 0),
            "normalDeleted": int(progress.get("normalDeleted", 0) or 0),
            "bossExpected": int(progress.get("bossExpected", 0) or 0),
            "bossDeleted": int(progress.get("bossDeleted", 0) or 0),
        }

        if self.post_frida("networkdrop", [json.dumps(payload, ensure_ascii=False)]):
            stage = payload.get("currentStage")
            if stage:
                with self.lock:
                    self.current_stage = stage
                    if self.last_drop:
                        self.last_drop["currentStage"] = stage
                    if self.display_drop:
                        self.display_drop["currentStage"] = stage

    def notify_frida_item_dropped(self, item, source):
        if not self.script:
            return
        self.post_frida("itemdropped", [str((item or {}).get("id", "")), source])

    def run_time_shift_cycle(self, minutes=15, restore_delay_ms=2000, continue_delay_ms=8000, next_index=None):
        with self.lock:
            if self.time_shift_running:
                self.add_log("[循环] 时间模式正在执行中，忽略重复触发")
                return False
            self.time_shift_running = True
            generation = self.time_shift_generation

        def worker():
            original = datetime.datetime.now()
            original_mono = time.monotonic()
            shifted = original + datetime.timedelta(minutes=minutes)
            try:
                self.add_log(f"[循环] 时间模式：电脑时间 +{minutes} 分钟")
                set_system_local_time(shifted)
                shifted_set_mono = time.monotonic()
                restore_delay_s = max(0, restore_delay_ms) / 1000
                restore_deadline = shifted_set_mono + restore_delay_s
                network_time = {}
                network_time_ready = threading.Event()

                def fetch_restore_time():
                    try:
                        network_time["beijing"] = fetch_beijing_time(timeout=0.6)
                        network_time["mono"] = time.monotonic()
                    except Exception as exc:
                        network_time["error"] = exc
                    finally:
                        network_time_ready.set()

                threading.Thread(target=fetch_restore_time, daemon=True).start()
                with self.lock:
                    self.system_time_shifted = True
                time.sleep(max(0.0, restore_deadline - time.monotonic()))
                if generation != self.time_shift_generation:
                    return
                restored_exact = False
                try:
                    beijing = network_time.get("beijing") if network_time_ready.is_set() else None
                    if beijing is None:
                        raise network_time.get("error") or RuntimeError("网络北京时间未在恢复倒计时内返回")
                    fetched_mono = float(network_time.get("mono") or time.monotonic())
                    beijing = beijing + datetime.timedelta(seconds=max(0.0, time.monotonic() - fetched_mono))
                    set_local_time_to_beijing(beijing)
                    restore_source = "北京时间"
                    restored_exact = True
                except Exception as sync_exc:
                    fallback = original + datetime.timedelta(seconds=max(0.0, time.monotonic() - original_mono))
                    set_system_local_time(fallback)
                    restore_source = "本地估算时间"
                    write_debug_log("time shift restore used fallback: " + sunny_error_cn(sync_exc))
                with self.lock:
                    self.system_time_shifted = not restored_exact
                self.add_log(f"[循环] 时间模式：电脑时间已恢复（{restore_source}），{max(0, continue_delay_ms) / 1000:g} 秒后继续")
                time.sleep(max(0, continue_delay_ms) / 1000)
                if generation != self.time_shift_generation:
                    return
                if self.script:
                    self.enqueue_script_export(
                        "continuetimeshift",
                        [],
                        "",
                    )
            except Exception as exc:
                self.add_log(f"[循环] 时间模式执行失败：{sunny_error_cn(exc)}")
                try:
                    if self.script:
                        self.enqueue_script_export(
                            "continuetimeshift",
                            [],
                            "",
                        )
                except Exception:
                    pass
            finally:
                with self.lock:
                    self.time_shift_running = False

        threading.Thread(target=worker, daemon=True).start()
        return True

    def remove_display_drop_head(self, box_kind=""):
        prefer_boss = "首领" in str(box_kind)
        payload = self.display_drop if isinstance(self.display_drop, dict) else None
        queues = payload.get("queues", []) if payload else []
        for queue in queues:
            if not isinstance(queue, dict):
                continue
            if bool(queue.get("eboxType") == 1) != prefer_boss:
                continue
            items = queue.get("items", []) or []
            if items:
                items.pop(0)
            break

    def remove_drop_item_from_payload(self, payload, item, box_kind=""):
        if not isinstance(payload, dict):
            return False, 0, 0
        name = str((item or {}).get("name") or "").strip()
        item_id = str((item or {}).get("id") or (item or {}).get("rewardItemId") or "").strip()
        if (not name or name == "?") and item_id:
            name = self.name_map.get(item_id, "")
        prefer_boss = "首领" in str(box_kind)
        removed = False
        normal_count = 0
        boss_count = 0
        queues = payload.get("queues", []) or []
        ordered = sorted(queues, key=lambda q: 0 if ((q.get("eboxType") == 1) == prefer_boss) else 1)
        for queue in ordered:
            items = list(queue.get("items", []) or [])
            kept = []
            for row in items:
                row_id = str((row or {}).get("id") or (row or {}).get("rewardItemId") or "").strip()
                row_name = str((row or {}).get("name") or "").strip()
                if not removed and ((item_id and row_id == item_id) or (name and row_name == name)):
                    removed = True
                    continue
                kept.append(row)
            queue["items"] = kept
        for queue in queues:
            if queue.get("eboxType") == 1:
                boss_count = len(queue.get("items", []) or [])
            elif queue.get("eboxType") == 0:
                normal_count = len(queue.get("items", []) or [])
        return removed, normal_count, boss_count

    def remove_item_from_current_drop_list(self, item, box_kind="", frontend=True):
        name = str((item or {}).get("name") or "").strip()
        item_id = str((item or {}).get("id") or "").strip()
        if (not name or name == "?") and item_id:
            name = self.name_map.get(item_id, "")
        if not name or name == "?":
            return False
        removed = False
        normal_count = 0
        boss_count = 0
        with self.lock:
            removed, normal_count, boss_count = self.remove_drop_item_from_payload(self.last_drop, item, box_kind)
            display_removed, _display_normal_count, _display_boss_count = self.remove_drop_item_from_payload(self.display_drop, item, box_kind)
            removed = removed or display_removed
        if removed:
            self.add_log(f"[掉落列表] 已移除已开出项目：{name}，当前列表 普通{normal_count} / 首领{boss_count}", frontend=frontend)
            self.notify_frida_network_drop(self.current_drop_sync_payload("本地删除"))
        return removed

    def pop_expected_drop_head(self, box_kind=""):
        prefer_boss = "首领" in str(box_kind)
        expected = None
        normal_count = 0
        boss_count = 0
        with self.lock:
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            ordered = sorted(queues, key=lambda q: 0 if ((q.get("eboxType") == 1) == prefer_boss) else 1)
            for queue in ordered:
                items = queue.get("items", []) or []
                if not items:
                    continue
                expected = dict(items.pop(0) or {})
                break
            for queue in queues:
                if queue.get("eboxType") == 1:
                    boss_count = len(queue.get("items", []) or [])
                elif queue.get("eboxType") == 0:
                    normal_count = len(queue.get("items", []) or [])
        return expected, normal_count, boss_count

    def current_drop_sync_payload(self, source="同步"):
        with self.lock:
            payload = copy.deepcopy(self.display_drop or self.last_drop)
            current_stage = self.current_stage
        if not isinstance(payload, dict):
            payload = {
                "type": "drop_update",
                "source": source,
                "currentStage": current_stage,
                "queues": [],
            }
        payload["type"] = "drop_update"
        payload["source"] = source
        payload["currentStage"] = payload.get("currentStage") or current_stage
        return payload

    def peek_expected_drop_head(self, box_kind=""):
        prefer_boss = "首领" in str(box_kind)
        expected = None
        normal_count = 0
        boss_count = 0
        with self.lock:
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            ordered = sorted(queues, key=lambda q: 0 if ((q.get("eboxType") == 1) == prefer_boss) else 1)
            for queue in ordered:
                items = queue.get("items", []) or []
                if not items:
                    continue
                expected = dict(items[0] or {})
                break
            for queue in queues:
                if queue.get("eboxType") == 1:
                    boss_count = len(queue.get("items", []) or [])
                elif queue.get("eboxType") == 0:
                    normal_count = len(queue.get("items", []) or [])
        return expected, normal_count, boss_count

    def handle_realtime_box_drop(self, payload):
        box_kind = str(payload.get("boxKind") or "")
        box_level = payload.get("boxLevel") or "?"
        expected, normal_count, boss_count = self.peek_expected_drop_head(box_kind)
        if not expected:
            self.add_log(f"[箱子掉落] Lv{box_level} {box_kind or '箱子'} -> 当前掉落列表为空，无法匹配预计物品")
            return
        item = self.item_plain(expected.get("id") or expected.get("rewardItemId") or "")
        if expected.get("name"):
            item["name"] = expected.get("name")
        if expected.get("grade"):
            item["grade"] = expected.get("grade")
        if expected.get("gradeKey"):
            item["gradeKey"] = expected.get("gradeKey")
        watched = bool(item.get("watched") or self.is_watch_item(item))
        item["watched"] = watched
        unique_key = self.notice_delete_unique_key(
            "realtime-box",
            box_kind,
            payload.get("timeKey") or payload.get("boxLevel") or item.get("id") or item.get("name"),
            item.get("name") or "",
        )
        if not self.mark_monitor_hold_deleted_once(unique_key):
            return
        self.remove_item_from_current_drop_list(item, box_kind)
        mark = "  *监控命中*" if watched else ""
        self.add_log_force(f"[箱子掉落] Lv{box_level} {box_kind or '箱子'} -> {item.get('name', '?')} {item.get('grade', '')}{mark}")
        self.add_obtained_item(item)
        if item.get("id"):
            self.notify_frida_item_dropped(item, "箱子掉落")
        if watched:
            self.queue_watch_notify([item], title="监控物品已掉落", start_detection=False)
        self.stop_drop_detection_if_idle()

    def handle_selected_drop(self, item_id):
        item_id = int(item_id or 0)
        item_id_str = str(item_id)
        matched_item = None
        matched_box_kind = ""
        with self.lock:
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            for queue in queues:
                queue_items = list(queue.get("items", []) or [])
                queue_box_kind = "首领" if queue.get("eboxType") == 1 else "普通"
                if not queue_items:
                    continue
                item = dict(queue_items[0] or {})
                candidates = [
                    str((item or {}).get("id") or "").strip(),
                    str((item or {}).get("rewardItemId") or "").strip(),
                    str((item or {}).get("rewardItemKey") or "").strip(),
                ]
                if any(c == item_id_str for c in candidates if c):
                    matched_item = item
                    matched_box_kind = queue_box_kind
                    break
                if matched_item:
                    break
        if not matched_item:
            self.add_log_force(f"[HOOK掉落] selected itemId={item_id_str} 未命中对应箱型列表第一位，已忽略", frontend=False)
            return False
        if not matched_item.get("id"):
            matched_item["id"] = item_id_str
        if not matched_item.get("name") or matched_item.get("name") == "?":
            matched_item["name"] = self.name_map.get(item_id_str, matched_item.get("name", ""))
        if not matched_item.get("gradeKey"):
            matched_item["gradeKey"] = self.grade_map.get(item_id_str, "")
        if not matched_item.get("grade"):
            matched_item["grade"] = self.grade_text(matched_item.get("gradeKey", ""))
        matched_item["watched"] = bool(matched_item.get("watched") or self.is_watch_item(matched_item))
        unique_key = self.notice_delete_unique_key(
            "hook",
            matched_box_kind,
            item_id_str,
            matched_item.get("name") or "",
        )
        removed = self.remove_item_from_current_drop_list(matched_item, matched_box_kind, frontend=True)
        if not removed:
            self.add_log_force(
                f"[HOOK掉落] itemId={item_id_str} {matched_box_kind} -> {matched_item.get('name', '?')} 列表未删除",
                frontend=False,
            )
            return False
        if not self.mark_monitor_hold_deleted_once(unique_key):
            self.add_log_force(
                f"[HOOK掉落] itemId={item_id_str} {matched_box_kind} -> {matched_item.get('name', '?')} 命中去重，已忽略重复删除",
                frontend=False,
            )
            return False
        with self.lock:
            recent_raw = str(getattr(self, "last_notice_box_raw_text", "") or "")
            recent_kind = str(getattr(self, "last_notice_box_kind", "") or "")
            recent_time = str(getattr(self, "last_notice_box_time_key", "") or "")
            recent_item_name = str(getattr(self, "last_notice_box_item_name", "") or "")
        if recent_raw and recent_kind == matched_box_kind:
            self.add_log(f"{recent_raw}，已删除{matched_box_kind}掉落列表第一行。")
        else:
            display_kind = "关卡宝箱" if matched_box_kind == "首领" else "普通宝箱"
            display_name = recent_item_name or matched_item.get("name") or "?"
            display_time = time.strftime("%H:%M")
            self.add_log(f"获得了{display_kind}({display_name})[{display_time}]，已删除{matched_box_kind}掉落列表第一行。")
        self.add_log_force(
            f"[HOOK掉落] itemId={item_id_str} {matched_box_kind} -> {matched_item.get('name', '?')} {matched_item.get('grade', '')}",
            frontend=False,
        )
        self.add_obtained_item(matched_item)
        if matched_item.get("id"):
            self.notify_frida_item_dropped(matched_item, "Hook掉落")
        if matched_item.get("watched"):
            self.queue_watch_notify([matched_item], title="监控物品已掉落", start_detection=False)
        self.stop_drop_detection_if_idle(last_item=matched_item)
        return True

    def handle_selected_reward_drop(self, payload):
        payload = payload or {}
        item = dict(payload.get("item") or {})
        item_id = str(item.get("id") or item.get("rewardItemId") or "").strip()
        if not item_id:
            return False
        box_kind = "首领" if "首领" in str(payload.get("boxKind") or "") else "普通"
        box_level = payload.get("boxLevel") or "?"
        text = str(payload.get("text") or "").strip()
        now = time.monotonic()
        dedupe_key = "|".join([
            item_id,
            box_kind,
            str(payload.get("boxId") or "").strip(),
            str(payload.get("source") or "").strip(),
        ])
        with self.lock:
            self.selected_reward_recent = {
                k: v for k, v in (self.selected_reward_recent or {}).items()
                if now - float(v or 0.0) < 3.0
            }
            last = float((self.selected_reward_recent or {}).get(dedupe_key, 0.0) or 0.0)
            if last and now - last < 1.5:
                return False
            self.selected_reward_recent[dedupe_key] = now
        if not item.get("name") or item.get("name") == "?":
            item["name"] = self.name_map.get(item_id, item.get("name", ""))
        if not item.get("id"):
            item["id"] = item_id
        if not item.get("grade"):
            item["grade"] = self.grade_text(self.grade_map.get(item_id, item.get("gradeKey", "")))
        if not item.get("gradeKey"):
            item["gradeKey"] = self.grade_map.get(item_id, "")
        watched = bool(item.get("watched") or self.is_watch_item(item))
        item["watched"] = watched
        if text:
            self.add_log_force(f"[HOOK掉落] {text}", frontend=False)
        else:
            mark = "  *监控命中*" if watched else ""
            self.add_log_force(
                f"[HOOK掉落] Lv{box_level} {box_kind} -> {item.get('name', '?')} {item.get('grade', '')}{mark}",
                frontend=False,
            )
        return False

    def add_obtained_item(self, item):
        item = item or {}
        item_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if (not name or name == "?") and item_id:
            name = self.name_map.get(item_id, "")
        if not name:
            return
        grade = str(item.get("grade") or "").strip()
        grade_key = str(item.get("gradeKey") or "").strip()
        if not grade_key and item_id:
            grade_key = self.grade_map.get(item_id, "")
        if not grade and grade_key:
            grade = self.grade_text(grade_key)
        key = item_id or name
        recent_key = f"{key}|{name}|{grade}"
        now = time.monotonic()
        with self.lock:
            self.obtained_recent = {
                k: v for k, v in self.obtained_recent.items()
                if now - v < 2.0
            }
            last = self.obtained_recent.get(recent_key)
            if last and now - last < 1.5:
                return
            self.obtained_recent[recent_key] = now
            row = self.obtained_items.get(key)
            if not row:
                row = {"id": item_id, "name": name, "grade": grade, "gradeKey": grade_key, "count": 0}
                self.obtained_items[key] = row
            row["count"] = int(row.get("count", 0)) + 1

    def item_from_drop_log_text(self, text):
        m = re.search(r"^\[箱子掉落\]\s+Lv\d+\s+(?:普通|首领|活动|箱子)\s+->\s+(.+?)\s+(\S+)(?:\s+\*监控命中\*)?$", str(text).strip())
        if not m:
            return None
        name = m.group(1).strip()
        grade = m.group(2).strip()
        found = next((x for x in self.item_catalog if x.get("name") == name and x.get("grade") == grade), None)
        if not found:
            found = next((x for x in self.item_catalog if x.get("name") == name), None)
        if found:
            return dict(found)
        return {"id": "", "name": name, "grade": grade, "gradeKey": ""}

    def remove_item_from_current_drop_list_once(self, item, box_kind=""):
        item = item or {}
        item_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        key = f"{item_id}|{name}|{box_kind}"
        now = time.monotonic()
        with self.lock:
            self.drop_list_remove_recent = {
                k: v for k, v in self.drop_list_remove_recent.items()
                if now - v < 2.0
            }
            last = self.drop_list_remove_recent.get(key)
            if last and now - last < 1.5:
                return False
            self.drop_list_remove_recent[key] = now
        self.remove_item_from_current_drop_list(item, box_kind)
        return True

    def apply_config(self, data, silent=False):
        silent = bool(silent or (isinstance(data, dict) and data.get("silent") is True))
        old_rewrite_enabled = self.config.get("rewriteEnabled", False) is True
        old_rewrite_lists = json.dumps(self.config.get("rewriteLists", self.response_rewrite_config), ensure_ascii=False, sort_keys=True)
        with self.lock:
            self.config["normalCount"] = int(data.get("normalCount", self.config.get("normalCount", 10)) or 10)
            self.config["bossCount"] = int(data.get("bossCount", self.config.get("bossCount", 5)) or 5)
            self.config["clickDelayMs"] = int(data.get("clickDelayMs", self.config.get("clickDelayMs", 15000)) or 0)
            self.config["pressIntervalMs"] = int(data.get("pressIntervalMs", self.config.get("pressIntervalMs", 450)) or 0)
            self.config["roleDeployDelayMs"] = int(data.get("roleDeployDelayMs", self.config.get("roleDeployDelayMs", 800)) or 0)
            self.config["switchMode"] = "time"
            self.config["loopPauseEvery"] = max(0, int(data.get("loopPauseEvery", self.config.get("loopPauseEvery", 0)) or 0))
            self.config["loopPauseMs"] = max(0, int(data.get("loopPauseMs", self.config.get("loopPauseMs", 0)) or 0))
            self.config["timeShiftEvery"] = max(1, int(data.get("timeShiftEvery", self.config.get("timeShiftEvery", 16)) or 16))
            self.config["timeShiftRestoreMs"] = max(0, int(data.get("timeShiftRestoreMs", self.config.get("timeShiftRestoreMs", 2000)) or 0))
            self.config["timeShiftContinueMs"] = max(0, int(data.get("timeShiftContinueMs", self.config.get("timeShiftContinueMs", 3000)) or 0))
            self.config["autoTimeShiftOnLimit"] = data.get("autoTimeShiftOnLimit", self.config.get("autoTimeShiftOnLimit", False)) is True
            self.config["stageWaveCount"] = max(0, int(data.get("stageWaveCount", self.config.get("stageWaveCount", 0)) or 0))
            self.config["autoStartAfterRecord"] = data.get("autoStartAfterRecord", self.config.get("autoStartAfterRecord", True)) is not False
            self.config["autoDepositEnabled"] = data.get("autoDepositEnabled", self.config.get("autoDepositEnabled", False)) is True
            self.config["autoDepositMinutes"] = max(1, int(data.get("autoDepositMinutes", self.config.get("autoDepositMinutes", 30)) or 30))
            self.runtime_auto_open_enabled = data.get("autoOpenEnabled", False) is True
            self.config["autoOpenAppearDelayMs"] = max(0, int(data.get("autoOpenAppearDelayMs", self.config.get("autoOpenAppearDelayMs", 300)) or 0))
            self.config["autoOpenIntervalMs"] = max(100, int(data.get("autoOpenIntervalMs", self.config.get("autoOpenIntervalMs", 10000)) or 100))
            self.config["autoOpenNormalTemplatePath"] = str(data.get("autoOpenNormalTemplatePath", self.config.get("autoOpenNormalTemplatePath", "")) or "").strip()
            self.config["autoOpenBossTemplatePath"] = str(data.get("autoOpenBossTemplatePath", self.config.get("autoOpenBossTemplatePath", "")) or "").strip()
            self.config["priceDisplayMode"] = "watchOnly"
            notice_left = max(0, int(data.get("noticeRectLeft", self.config.get("noticeRectLeft", int(round(DEFAULT_NOTICE_RELATIVE_RECT[0] * OCR_BASE_CAPTURE_WIDTH)))) or 0))
            notice_top = max(0, int(data.get("noticeRectTop", self.config.get("noticeRectTop", int(round(DEFAULT_NOTICE_RELATIVE_RECT[1] * OCR_BASE_CAPTURE_HEIGHT)))) or 0))
            notice_right = max(notice_left + 1, int(data.get("noticeRectRight", self.config.get("noticeRectRight", int(round(DEFAULT_NOTICE_RELATIVE_RECT[2] * OCR_BASE_CAPTURE_WIDTH)))) or 0))
            notice_bottom = max(notice_top + 1, int(data.get("noticeRectBottom", self.config.get("noticeRectBottom", int(round(DEFAULT_NOTICE_RELATIVE_RECT[3] * OCR_BASE_CAPTURE_HEIGHT)))) or 0))
            self.config["noticeRectLeft"] = notice_left
            self.config["noticeRectTop"] = notice_top
            self.config["noticeRectRight"] = notice_right
            self.config["noticeRectBottom"] = notice_bottom
            self.config["noticeRectLeftRel"] = notice_left / OCR_BASE_CAPTURE_WIDTH
            self.config["noticeRectTopRel"] = notice_top / OCR_BASE_CAPTURE_HEIGHT
            self.config["noticeRectRightRel"] = notice_right / OCR_BASE_CAPTURE_WIDTH
            self.config["noticeRectBottomRel"] = notice_bottom / OCR_BASE_CAPTURE_HEIGHT
            self.config["watchNames"] = self.watch_entries_with_legacy_ids(
                data.get("watchNames", self.config.get("watchNames", [])) or [],
                data.get("watchIds", []),
            )
            self.config["watchIds"] = self.watch_ids_from_entries(self.config.get("watchNames", []))
            self.config["notifyMode"] = data.get("notifyMode", self.config.get("notifyMode", "app"))
            self.config["notifySound"] = data.get("notifySound", self.config.get("notifySound", "ding"))
            self.config["rewriteEnabled"] = data.get("rewriteEnabled", self.config.get("rewriteEnabled", False)) is True
            rewrite_lists = data.get("rewriteLists", self.config.get("rewriteLists", self.response_rewrite_config))
            cleaned = {}
            if isinstance(rewrite_lists, dict):
                for queue_id, ids in rewrite_lists.items():
                    if isinstance(ids, list):
                        cleaned[str(queue_id)] = [str(x).strip() for x in ids if str(x).strip()]
            self.config["rewriteLists"] = cleaned
            self.response_rewrite_config = dict(cleaned)
            self.response_rewrite_indices = {k: v for k, v in self.response_rewrite_indices.items() if k in cleaned}
            cfg_file = self.save_config()
            rewrite_changed = (
                old_rewrite_enabled != (self.config.get("rewriteEnabled", False) is True) or
                old_rewrite_lists != json.dumps(self.config.get("rewriteLists", self.response_rewrite_config), ensure_ascii=False, sort_keys=True)
            )
            if self.script:
                if self.has_visible_watched_items():
                    self.start_drop_detection_for_watch()
                else:
                    self.stop_box_scan_worker()
        if self.script:
            cfg = {
                "normalCount": cfg_file["display"]["normalCount"],
                "bossCount": cfg_file["display"]["bossCount"],
                "clickDelayMs": cfg_file["display"]["clickDelayMs"],
                "pressIntervalMs": cfg_file["display"].get("pressIntervalMs", 450),
                "roleDeployDelayMs": cfg_file["display"].get("roleDeployDelayMs", 800),
                "switchMode": "time",
                "loopPauseEvery": cfg_file["display"].get("loopPauseEvery", 0),
                "loopPauseMs": cfg_file["display"].get("loopPauseMs", 0),
                "timeShiftEvery": cfg_file["display"].get("timeShiftEvery", 16),
                "timeShiftRestoreMs": cfg_file["display"].get("timeShiftRestoreMs", 2000),
                "timeShiftContinueMs": cfg_file["display"].get("timeShiftContinueMs", 3000),
                "autoTimeShiftOnLimit": cfg_file["display"].get("autoTimeShiftOnLimit", False),
                "stageWaveCount": cfg_file["display"].get("stageWaveCount", 0),
                "autoStartAfterRecord": cfg_file["display"].get("autoStartAfterRecord", True),
                "autoDepositEnabled": self.config.get("autoDepositEnabled", False) is True,
                "autoDepositMinutes": cfg_file["display"].get("autoDepositMinutes", 30),
                "autoOpenEnabled": self.runtime_auto_open_enabled,
                "autoOpenAppearDelayMs": cfg_file["autoOpen"].get("appearDelayMs", 300),
                "autoOpenIntervalMs": cfg_file["autoOpen"].get("intervalMs", 10000),
                "autoOpenNormalTemplatePath": cfg_file["autoOpen"].get("normalTemplatePath", ""),
                "autoOpenBossTemplatePath": cfg_file["autoOpen"].get("bossTemplatePath", ""),
                "noticeRectLeft": int(self.config.get("noticeRectLeft", int(round(DEFAULT_NOTICE_RELATIVE_RECT[0] * OCR_BASE_CAPTURE_WIDTH)))),
                "noticeRectTop": int(self.config.get("noticeRectTop", int(round(DEFAULT_NOTICE_RELATIVE_RECT[1] * OCR_BASE_CAPTURE_HEIGHT)))),
                "noticeRectRight": int(self.config.get("noticeRectRight", int(round(DEFAULT_NOTICE_RELATIVE_RECT[2] * OCR_BASE_CAPTURE_WIDTH)))),
                "noticeRectBottom": int(self.config.get("noticeRectBottom", int(round(DEFAULT_NOTICE_RELATIVE_RECT[3] * OCR_BASE_CAPTURE_HEIGHT)))),
                "watchEnabled": cfg_file["watch"]["enabled"],
                "watchNames": cfg_file["watch"]["names"],
                "watchIds": cfg_file["watch"]["ids"],
                "matchMode": cfg_file["watch"]["matchMode"],
                "highlightBackgroundAnsi": cfg_file["watch"]["highlightBackgroundAnsi"],
            }
            try:
                self.post_frida("updateconfig", [json.dumps(cfg, ensure_ascii=False)])
                if not silent:
                    self.add_log("配置已应用到脚本")
            except Exception as exc:
                self.add_log(f"配置应用失败: {exc}")
        if rewrite_changed and self.session:
            try:
                self.load_frida_network_probe()
            except Exception as exc:
                self.add_log(f"刷新响应替换脚本失败：{sunny_error_cn(exc)}")
        elif not silent:
            self.add_log("配置已保存，脚本加载后会自动应用")
        return self.response(True, "配置已应用")

    def apply_rewrite_enabled(self, data):
        with self.lock:
            self.config["rewriteEnabled"] = data.get("rewriteEnabled") is True
        return self.response(True, "响应替换已启用" if self.config["rewriteEnabled"] else "响应替换已关闭")

    def set_market_currency(self, data):
        code = str((data or {}).get("code") or DEFAULT_MARKET_CURRENCY).strip().upper()
        with self.lock:
            valid = {str((row or {}).get("code") or "").strip().upper() for row in (self.market_currency_options or [])}
            if valid and code not in valid:
                code = self.market_currency_code if self.market_currency_code in valid else sorted(valid)[0]
            self.market_currency_code = code or DEFAULT_MARKET_CURRENCY
            self.market_version += 1
        return self.market_prices_response({"ids": []}, ok=True, message="汇率已切换")

    def response(self, ok=True, message="", include_script_status=True):
        if self.script:
            self.drain_pending_host_commands()
            self.drain_pending_script_exports()
        if include_script_status and (self.script or self.session) and not self.time_shift_running:
            self.ensure_game_process_alive()
        with self.lock:
            notify = self.pending_notify
            self.pending_notify = None
            last_drop = self.display_drop or self.last_drop
            obtained_items = sorted(
                self.obtained_items.values(),
                key=lambda x: (-(self.grade_rank(str(x.get("gradeKey", ""))) or self.grade_text_rank(str(x.get("grade", "")))), str(x.get("name", "")))
            )
            current_stage = self.current_stage
            config = dict(self.config)
            config["autoOpenEnabled"] = self.runtime_auto_open_enabled
            config["priceDisplayMode"] = "watchOnly"
            attaching = bool(self.attaching)
            market_currency_code = self.market_currency_code
            market_currencies = list(self.market_currency_options or [])
            market_version = int(self.market_version or 0)
            market_ready = bool(self.market_ready)
            cached_script_status = dict(self.script_status_cache or {})
        script_status = self.get_script_status() if (include_script_status and not self.time_shift_running) else {}
        if not script_status:
            script_status = cached_script_status
        auto_open_status = script_status.get("autoOpen", {}) if isinstance(script_status.get("autoOpen", {}), dict) else {}
        cross_loop_status = script_status.get("crossLoop", {}) if isinstance(script_status.get("crossLoop", {}), dict) else {}
        recorded_buttons = script_status.get("recorded", [])
        if not (isinstance(recorded_buttons, list) and any(bool(row and row.get("ptr")) for row in recorded_buttons if isinstance(row, dict))):
            recorded_buttons = self.current_recorded_buttons_cache()
        return {
            "ok": ok,
            "message": message,
            "connected": self.script is not None,
            "attaching": attaching,
            "attachStage": str(self.attach_stage or ""),
            "attachDetail": str(self.attach_detail or ""),
            "readyDone": self.ready_done and self.ocr_ready and self.market_live_ready,
            "readyLoading": bool(self.ready_loading),
            "running": self.running or bool(cross_loop_status.get("running")),
            "crossLoop": cross_loop_status,
            "autoStarted": self.auto_started,
            "statusText": self.status_text,
            "processText": PROCESS_NAME,
            "currentStage": current_stage,
            "config": config,
            "recordedButtons": recorded_buttons,
            "recordingIndex": script_status.get("recordingIndex", None),
            "rewriteEnabled": config.get("rewriteEnabled", False) is True,
            "rewriteLists": dict(config.get("rewriteLists", self.response_rewrite_config)),
            "lastDrop": last_drop,
            "monitorHoldProgress": {
                "expected": int(self.monitor_hold_progress().get("expected", 0) or 0),
                "deleted": int(self.monitor_hold_progress().get("deleted", 0) or 0),
                "normalExpected": int(self.monitor_hold_progress().get("normalExpected", 0) or 0),
                "normalDeleted": int(self.monitor_hold_progress().get("normalDeleted", 0) or 0),
                "bossExpected": int(self.monitor_hold_progress().get("bossExpected", 0) or 0),
                "bossDeleted": int(self.monitor_hold_progress().get("bossDeleted", 0) or 0),
            },
            "obtainedItems": obtained_items,
            "marketMeta": {
                "version": market_version,
                "currencyCode": market_currency_code,
                "currencies": market_currencies,
                "ready": market_ready,
            },
            "logs": self.pop_logs(),
            "notify": notify,
        }

    def format_rpc_result(self, name, result):
        labels = {
            "ready": "",
            "start": "开始循环",
            "stop": "停止循环",
            "clear": "已清空录制",
        }
        if name == "status":
            return f"状态：{result}"
        return labels.get(name, f"{name}: {result}")

    def format_drop_summary(self, payload):
        stage = payload.get("currentStage") or "未知"
        queues = payload.get("queues", [])
        return f"[{payload.get('source', '更新')}] {len(queues)} 个掉落队列 当前关卡：{stage}"

    def format_drop_event(self, payload):
        item = payload.get("item", {}) or {}
        kind = "监控命中" if payload.get("watched") else "普通掉落"
        return f"[{payload.get('source', '掉落')}] {kind}: {self.format_item_line(item)}"

    def queue_watch_notify(self, items, title="发现监控物品", stage=None, start_detection=True):
        rows = [item for item in (items or []) if isinstance(item, dict)]
        if not rows:
            return False
        stage = stage or self.current_stage or ""
        keys = []
        lines = []
        for item in rows[:4]:
            item_id = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            grade = str(item.get("grade") or "").strip()
            keys.append(item_id or f"{name}|{grade}")
            lines.append(self.format_item_line(item))
        if not lines:
            return False
        key = f"{title}|{stage}|{'|'.join(keys)}"
        now = time.monotonic()
        with self.lock:
            self.notify_recent = {
                k: v for k, v in self.notify_recent.items()
                if now - v < 3.0
            }
            last = self.notify_recent.get(key)
            if last and now - last < 3.0:
                return False
            self.notify_recent[key] = now
            self.pending_notify = {
                "title": title,
                "body": "\n".join(lines),
            }
        self.play_backend_notice_sound()
        if start_detection and self.running:
            self.start_drop_detection_for_watch()
        return True

    def play_backend_notice_sound(self):
        if str(self.config.get("notifySound", "ding") or "ding") == "off":
            return
        try:
            import winsound
            sound = str(self.config.get("notifySound", "ding") or "ding")
            if sound == "alert":
                winsound.Beep(1047, 120)
                winsound.Beep(784, 90)
            elif sound == "soft":
                winsound.Beep(659, 160)
            else:
                winsound.MessageBeep(winsound.MB_ICONASTERISK)
        except Exception:
            pass

    def current_visible_watched_items(self):
        visible = []
        with self.lock:
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            normal_limit = max(0, int(self.config.get("normalCount", 10) or 0))
            boss_limit = max(0, int(self.config.get("bossCount", 5) or 0))
            for queue in queues:
                if not isinstance(queue, dict):
                    continue
                items = queue.get("items") or []
                if queue.get("eboxType") == 1:
                    limit = min(len(items), boss_limit)
                elif queue.get("eboxType") == 0:
                    limit = min(len(items), normal_limit)
                else:
                    continue
                for row in items[:limit]:
                    if self.is_watch_item(row):
                        visible.append(dict(row or {}))
        return visible

    def has_visible_watched_items(self):
        return bool(self.current_visible_watched_items())

    def start_drop_detection_for_watch(self):
        if not self.running:
            return False
        visible = self.current_visible_watched_items()
        expected_count = len(visible)
        normal_expected = 0
        boss_expected = 0
        for row in visible:
            item_id = str((row or {}).get("id") or (row or {}).get("rewardItemId") or "").strip()
            if item_id.startswith("920"):
                boss_expected += 1
            else:
                normal_expected += 1
        with self.lock:
            current_expected = int(self.monitor_hold_expected_count or 0)
            current_deleted = int(self.monitor_hold_deleted_count or 0)
            if expected_count > 0 and (current_expected <= 0 or current_deleted >= current_expected):
                self.monitor_hold_expected_count = expected_count
                self.monitor_hold_deleted_count = 0
                self.monitor_hold_expected_normal = normal_expected
                self.monitor_hold_deleted_normal = 0
                self.monitor_hold_expected_boss = boss_expected
                self.monitor_hold_deleted_boss = 0
                self.monitor_hold_delete_keys = set()
            self.expected_notice_box_kind = ""
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
        self.add_log("[OCR] 已启动后台识别，循环检测最新宝箱提示", frontend=False)
        self.start_notice_ocr_worker()
        self.stop_box_scan_worker()
        return True

    def stop_drop_detection_if_idle(self, last_item=None):
        progress = self.monitor_hold_progress()
        expected = int(progress.get("expected", 0) or 0)
        deleted = int(progress.get("deleted", 0) or 0)
        if self.has_visible_watched_items():
            return False
        if expected > 0 and deleted < expected:
            return False
        item = last_item if isinstance(last_item, dict) else None
        if item and item.get("id"):
            self.notify_frida_item_dropped(item, "OCR列表已清空")
        with self.lock:
            self.expected_notice_box_kind = ""
            self.pending_box_notice_kind = ""
            self.pending_box_notice_time_key = ""
            self.ignore_next_notice_ocr_result = False
        self.stop_notice_ocr_worker()
        self.stop_box_scan_worker()
        return True

    def visible_watch_item(self, item):
        item = item or {}
        item_id = str(item.get("id") or "").strip()
        if not item_id:
            return False
        with self.lock:
            payload = self.last_drop if isinstance(self.last_drop, dict) else None
            queues = payload.get("queues", []) if payload else []
            normal_limit = max(0, int(self.config.get("normalCount", 10) or 0))
            boss_limit = max(0, int(self.config.get("bossCount", 5) or 0))
            for queue in queues:
                if not isinstance(queue, dict):
                    continue
                items = queue.get("items") or []
                if queue.get("eboxType") == 1:
                    limit = min(len(items), boss_limit)
                elif queue.get("eboxType") == 0:
                    limit = min(len(items), normal_limit)
                else:
                    continue
                for row in items[:limit]:
                    if str((row or {}).get("id") or "") != item_id:
                        continue
                    return True
        return False

    def format_item_line(self, item):
        return f"{item.get('name', '?')} / {item.get('grade', '')} / {item.get('id', '')}"

    def resolve_box_template_paths(self, normal_template_path="", boss_template_path=""):
        resolved_normal_template_path = str(normal_template_path or "").strip()
        resolved_boss_template_path = str(boss_template_path or "").strip()
        if not resolved_normal_template_path:
            resolved_normal_template_path = str(APP_DIR / "box_drop_templates" / "normal.png")
        if not resolved_boss_template_path:
            resolved_boss_template_path = str(APP_DIR / "box_drop_templates" / "normal.png")
        return resolved_normal_template_path, resolved_boss_template_path

    def test_box_template(self, kind, normal_template_path="", boss_template_path=""):
        kind_text = "首领" if str(kind) == "boss" else "普通"
        started = time.perf_counter()
        image, _hwnd, _rect = self.capture_taskbarhero_window()
        if image is None:
            return {"ok": False, "message": "截图失败，无法测试找图"}
        resolved_normal_template_path, resolved_boss_template_path = self.resolve_box_template_paths(
            normal_template_path,
            boss_template_path,
        )
        try:
            debug_dir = APP_DIR / "output" / "ocr_debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            save_bgra_bmp(image, debug_dir / f"test_box_{str(kind or 'normal')}_full.bmp")
        except Exception:
            write_debug_log("save test box screenshot failed:\n" + traceback.format_exc())
        result = self.ocr_service_request(
            "/match-box",
            {
                "image": image,
                "kind": str(kind or "normal"),
                "normalTemplatePath": resolved_normal_template_path,
                "bossTemplatePath": resolved_boss_template_path,
                "threshold": BOX_MATCH_THRESHOLD,
            },
            timeout=12,
        )
        elapsed_ms = float(result.get("elapsedMs", (time.perf_counter() - started) * 1000) or 0.0)
        match = result.get("match") if result.get("ok") else None
        try:
            debug_dir = APP_DIR / "output" / "ocr_debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            if match and match.get("rect"):
                draw_match_rect_on_bgra_image(
                    image,
                    match.get("rect"),
                    debug_dir / f"test_box_{str(kind or 'normal')}_marked.bmp",
                    color=(0, 255, 0, 255),
                    thickness=3,
                )
        except Exception:
            write_debug_log("save test box marked screenshot failed:\n" + traceback.format_exc())
        if not match:
            return {"ok": False, "message": f"未找到{kind_text}箱", "score": 0.0, "elapsedMs": elapsed_ms}
        return {
            "ok": True,
            "message": f"{kind_text}箱测试完成",
            "score": float(match.get("score", 0.0)),
            "elapsedMs": float(elapsed_ms),
            "canAutoOpen": float(match.get("score", 0.0)) >= BOX_MATCH_THRESHOLD,
        }

    def test_notice_rect(self):
        started = time.perf_counter()
        image, _hwnd, _rect = self.capture_taskbarhero_window()
        if image is None:
            return {"ok": False, "message": "截图失败，无法测试掉落识别坐标"}
        raw_text, _item_name, _time_key, _box_kind = self.run_notice_ocr_once(image)
        elapsed_ms = float((time.perf_counter() - started) * 1000.0)
        text = str(raw_text or "").strip()
        if not text:
            return {"ok": False, "message": "未识别到文字", "text": "", "elapsedMs": elapsed_ms}
        return {"ok": True, "message": "识图成功", "text": text, "elapsedMs": elapsed_ms}

    def capture_box_template(self, kind):
        kind_text = "首领" if str(kind) == "boss" else "普通"
        image, _hwnd, _rect = self.capture_taskbarhero_window()
        if image is None:
            return {"ok": False, "message": f"截图失败，无法截取{kind_text}箱图片"}
        capture_id = hashlib.sha1(f"{kind}|{time.time()}|{image.get('width')}|{image.get('height')}".encode("utf-8")).hexdigest()[:16]
        preview_image, preview_scale = make_preview_image(image, max_width=960)
        if preview_image is None:
            return {"ok": False, "message": f"生成{kind_text}预览图失败"}
        try:
            prefix = "boss_preview_" if str(kind) == "boss" else "normal_preview_"
            for old_file in self.ui_static_root.glob(f"{prefix}*.png"):
                old_file.unlink(missing_ok=True)
        except Exception:
            pass
        preview_name = preview_capture_name(kind, capture_id)
        preview_path = self.ui_static_root / preview_name
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        if not save_bgra_png(preview_image, preview_path):
            return {"ok": False, "message": f"保存{kind_text}预览图失败"}
        self.pending_box_template_capture = {
            "id": capture_id,
            "kind": str(kind),
            "image": image,
            "previewScale": float(preview_scale or 1.0),
            "previewWidth": int(preview_image.get("width") or 0),
            "previewHeight": int(preview_image.get("height") or 0),
            "previewName": preview_name,
            "previewPath": str(preview_path),
            "createdAt": time.time(),
        }
        return {
            "ok": True,
            "message": f"已截取整窗，请框选{kind_text}箱图标",
            "captureId": capture_id,
            "width": int(preview_image.get("width") or 0),
            "height": int(preview_image.get("height") or 0),
            "imageUrl": preview_name,
        }

    def save_box_template_capture(self, kind, capture_id, rect):
        kind_text = "首领" if str(kind) == "boss" else "普通"
        pending = self.pending_box_template_capture or {}
        if not pending or str(pending.get("id") or "") != str(capture_id or "").strip():
            return {"ok": False, "message": "截图会话已失效，请重新点击截图"}
        image = pending.get("image")
        preview_scale = float(pending.get("previewScale") or 1.0)
        parsed_rect = self.normalize_capture_rect(rect, image, preview_scale)
        if not parsed_rect:
            return {"ok": False, "message": f"请先框选{kind_text}箱图标区域"}
        crop = crop_bgra_image(image, parsed_rect)
        if crop is None:
            return {"ok": False, "message": f"截取{kind_text}箱图片失败"}
        template_dir = APP_DIR / "box_drop_templates"
        template_dir.mkdir(parents=True, exist_ok=True)
        filename = "boss_capture.bmp" if str(kind) == "boss" else "normal_capture.bmp"
        output_path = template_dir / filename
        if not save_bgra_bmp(crop, output_path):
            return {"ok": False, "message": f"保存{kind_text}箱图片失败"}
        self.pending_box_template_capture = None
        return {"ok": True, "message": f"已保存{kind_text}箱图片：{output_path}", "path": str(output_path)}

    def normalize_capture_rect(self, rect, image, preview_scale=1.0):
        if not isinstance(image, dict) or not isinstance(rect, dict):
            return None
        width = int(image.get("width") or 0)
        height = int(image.get("height") or 0)
        if width <= 0 or height <= 0:
            return None
        try:
            scale = float(preview_scale or 1.0)
            if scale <= 0:
                scale = 1.0
            left = int(round(float(rect.get("left")) / scale))
            top = int(round(float(rect.get("top")) / scale))
            right = int(round(float(rect.get("right")) / scale))
            bottom = int(round(float(rect.get("bottom")) / scale))
        except Exception:
            return None
        left = max(0, min(left, width - 1))
        top = max(0, min(top, height - 1))
        right = max(left + 1, min(right, width))
        bottom = max(top + 1, min(bottom, height))
        if right - left < 2 or bottom - top < 2:
            return None
        return left, top, right, bottom

def main():
    write_debug_log("程序启动")
    if relaunch_as_admin_if_needed():
        return 0
    enable_devmod = not is_packaged_app()
    write_debug_log(f"管理员权限={is_windows_admin()}")
    write_debug_log(f"JadeView开发模式={enable_devmod}")
    write_debug_log(f"APP_DIR={APP_DIR}")
    write_debug_log(f"RESOURCE_DIR={RESOURCE_DIR}")
    write_debug_log(f"SCRIPT_PATH={SCRIPT_PATH} exists={SCRIPT_PATH.exists()}")
    write_debug_log(f"CONFIG_PATH={CONFIG_PATH} exists={CONFIG_PATH.exists()}")
    write_debug_log(f"DEFAULT_CONFIG_PATH={DEFAULT_CONFIG_PATH} exists={DEFAULT_CONFIG_PATH.exists()}")
    try:
        import jadeview
        from jadeview import ipc, tools, window
    except ModuleNotFoundError:
        write_debug_log("未安装 jadeview")
        print("未安装 jadeview，请先安装 JadeView Python SDK2")
        return 1

    backend = DropBackend()
    api = JadeApi(backend)
    static_root = write_test_html(backend.item_catalog)
    base_url = tools.set_protocol_service_path(str(static_root))
    if not base_url:
        write_debug_log("JadeView 本地文件服务启动失败")
        print("JadeView 本地文件服务启动失败")
        return 1
    api.base_url = base_url
    backend.base_url = base_url
    backend.ui_static_root = static_root
    print(f"HTML 已生成：{static_root / 'index.html'}", flush=True)
    print(f"Jade 本地地址：{base_url}index.html", flush=True)

    def ipc_response(channel, window_id, payload):
        result = api.handle(channel, window_id, payload)
        if isinstance(result, (dict, list)):
            return json.dumps(result, ensure_ascii=False)
        return result

    for channel in ["attach", "detach", "ready", "start", "stop", "startcross", "stopcross", "status", "clear", "windowAction", "shutdownAndClose", "notify", "uiReady", "checkUpdate", "startUpdate", "quickState", "getState", "getMarketPrices", "recordStatus", "applyConfig", "applyRewriteEnabled", "setMarketCurrency", "recordButton", "clearRecordButton", "testBoxTemplate", "testNoticeRect", "chooseBoxTemplate", "captureBoxTemplate", "saveBoxTemplateCapture"]:
        ipc.register_ipc_handler(channel, lambda window_id, payload, ch=channel: ipc_response(ch, window_id, payload))

    shutting_down = False

    def shutdown():
        nonlocal shutting_down
        if shutting_down:
            return None
        shutting_down = True
        print("JadeView 已关闭，退出控制台", flush=True)
        try:
            jadeview.cleanup()
        finally:
            os._exit(0)

    def shutdown_after_detach():
        write_crash_log("JadeView window close event received, detach and shutdown")
        try:
            backend.detach_sync()
        except Exception:
            write_crash_log("window-close detach failed:\n" + traceback.format_exc())
        shutdown()

    api.shutdown = shutdown

    def on_app_ready(window_id, data):
        api.window_id = window.create_webview_window(
            api.base_url + "index.html",
            title="TBH掉落监控-观星/祈祷   By.残枫",
            width=1320,
            height=840,
            min_width=1060,
            min_height=620,
            frame_style="no-titlebar",
            resizable=1,
            background_color="#f5f5f7",
            hide_window=1,
            focus=0,
        )
        print(f"JadeView 窗口ID：{api.window_id}", flush=True)
        write_debug_log(f"JadeView 窗口ID：{api.window_id}")
        if not api.window_id:
            write_debug_log("JadeView 窗口创建失败")
            print("JadeView 窗口创建失败", flush=True)
        return None

    ipc.on("app-ready", on_app_ready)
    ipc.on("window-all-closed", lambda window_id, data: shutdown_after_detach())
    ipc.on("window-closed", lambda window_id, data: shutdown_after_detach() if window_id == api.window_id else None)

    if not jadeview.init("TBH Drop Items Monitor", "canfeng.tbh.dropitems", enable_devmod=enable_devmod):
        write_debug_log("JadeView 初始化失败")
        print("JadeView 初始化失败")
        return 1

    jadeview.run()
    jadeview.cleanup()
    write_debug_log("程序正常退出")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit as exc:
        if exc.code not in (0, None):
            pause_debug_console_on_exit()
        raise
    except Exception:
        text = "未捕获异常\n" + traceback.format_exc()
        write_debug_log(text)
        try:
            print(text, flush=True)
        except Exception:
            pass
        pause_debug_console_on_exit()
        raise


