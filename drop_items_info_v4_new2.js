'use strict';

var __consoleLog = console.log;

function sendLogLine(line) {
    try {
        send({
            type: 'log',
            text: '' + line
        });
    } catch (e) {}
}
console.log = function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
    var line = parts.join(' ');
    __consoleLog(line);
    sendLogLine(line);
};

var GA = Process.enumerateModules().find(function(m) {
    return m.name.toLowerCase().indexOf('gameassembly') !== -1;
});
if (!GA) throw new Error('GameAssembly.dll not found');
var B = GA.base;
console.log('GameAssembly.dll @ ' + B);

// Resolve exported IL2CPP APIs by name so game updates do not invalidate RVAs.
function api(name, ret, args) {
    return new NativeFunction(GA.getExportByName(name), ret, args);
}
var dn = api('il2cpp_domain_get', 'pointer', []);
var daf = api('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
var aif = api('il2cpp_assembly_get_image', 'pointer', ['pointer']);
var cfn = api('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
var cmfn = api('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
var cnf = api('il2cpp_class_get_name', 'pointer', ['pointer']);
var cgffn = api('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
var fgo = api('il2cpp_field_get_offset', 'int', ['pointer']);
var fgt = api('il2cpp_field_get_type', 'pointer', ['pointer']);
var cgf = api('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
var cgm = api('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
var mgn = api('il2cpp_method_get_name', 'pointer', ['pointer']);
var mgpc = api('il2cpp_method_get_param_count', 'int', ['pointer']);
var mgrt = api('il2cpp_method_get_return_type', 'pointer', ['pointer']);
var tgn = api('il2cpp_type_get_name', 'pointer', ['pointer']);

function cstr(s) {
    return Memory.allocUtf8String(s);
}

// Find only minimal methods required by UI recording/replay
var d = dn();
var sz = Memory.alloc(4);
var asms = daf(d, sz);
var cnt = sz.readU32();

var emptyNs = cstr('');
var found = {};
var iccf = api('il2cpp_image_get_class_count', 'int', ['pointer']);
var icf = api('il2cpp_image_get_class', 'pointer', ['pointer', 'int']);

function rememberMethod(label, key, methodInfo) {
    if (!methodInfo || methodInfo.isNull() || found[key]) return false;
    var fp = methodInfo.readPointer();
    if (!fp || fp.isNull()) return false;
    found[key] = fp;
    console.log('  ' + label + ' @ RVA=0x' + fp.sub(B).toInt32().toString(16));
    return true;
}

function methodPtr(methodInfo) {
    try {
        if (!methodInfo || methodInfo.isNull()) return ptr(0);
        var fp = methodInfo.readPointer();
        if (!fp || fp.isNull()) return ptr(0);
        return fp;
    } catch (e) {
        return ptr(0);
    }
}

function installStageDataWaveHook() {
    if (g_stageDataHookInstalled) return true;
    try {
        var pattern = '8B 49 4C 48 8D 54 24 40';
        var ranges = Process.enumerateRanges({
            protection: 'r-x',
            coalesce: true
        }).filter(function(r) {
            return r.base.compare(B) >= 0 && r.base.compare(B.add(GA.size)) < 0;
        });
        for (var ri = 0; ri < ranges.length; ri++) {
            var matches = Memory.scanSync(ranges[ri].base, ranges[ri].size, pattern);
            if (!matches || matches.length <= 0) continue;
            var address = matches[0].address;
            Interceptor.attach(address, {
                onEnter: function(args) {
                    try {
                        g_stageDataPtr = this.context.rcx;
                        applyStageWaveCountNow();
                    } catch (e) {}
                }
            });
            g_stageDataHookInstalled = true;
            log('[关卡波数] StageData Hook RVA=0x' + address.sub(B).toInt32().toString(16));
            return true;
        }
    } catch (e) {
        log('[关卡波数] StageData Hook 失败：' + e);
    }
    log('[关卡波数] 未找到 StageData AOB');
    return false;
}

function configuredStageWaveCount() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var value = parseInt(display.stageWaveCount, 10);
    if (isNaN(value) || value <= 0) return 0;
    return Math.min(9999, value);
}

function applyStageWaveCountNow() {
    var value = configuredStageWaveCount();
    if (value <= 0) return false;
    if (!g_stageDataPtr || g_stageDataPtr.isNull()) return false;
    try {
        g_stageDataPtr.add(0x54).writeS32(value);
        g_stageWaveLastApplyAt = Date.now();
        return true;
    } catch (e) {
        log('[关卡波数] 写入失败：' + e);
        return false;
    }
}

// ======== Memory drop hooking ========
var ENABLE_MEMORY_DROP_HOOKS = true;
var ENABLE_MEMORY_DROP_LIST_MONITOR = false;
var ENABLE_SELECTED_REWARD_WATCH = true;
var SELECTED_REWARD_BOX_WINDOW_MS = 2500;
var SELECTED_REWARD_EMIT_GAP_MS = 800;

var g_vw = null;
var g_dropCount = 0;
var g_boxOpenCount = 0;
var g_selectedRewardCount = 0;
var g_selectedRewardActiveUntil = 0;
var g_selectedRewardLastBoxId = '';
var g_selectedRewardConfirmedBoxId = '';
var g_selectedRewardConfirmedUntil = 0;
var g_selectedRewardLastKey = '';
var g_selectedRewardLastAt = 0;
var g_selectedRewardCandidatePtr = ptr(0);
var g_selectedRewardPending = null;
var g_firstJsqSeen = false;
var g_queuesDisplayed = false;
var g_snapshots = new Map();
var g_bexlLastDebug = '';
var g_vwBexlOffset = 0x10;
var g_vwIsBexlDirect = false;
var g_bexlOwnerScanLastMs = 0;
var g_bexlOwnerDeepScanLastMs = 0;
var g_responseMemoryLastSig = '';
var g_responseMemoryLastScanMs = 0;
var g_refreshSeq = 0;
var g_stageDataPtr = ptr(0);
var g_stageDataHookInstalled = false;
var g_stageWaveLastApplyAt = 0;
var g_stageBaselineSig = null;
var g_config = loadConfig();
var foundMeta = {};
var g_vwSlot = Memory.alloc(Process.pointerSize);
var g_dropHooksTotal = 0;
var g_lastFallbackSelectedPtr = '';
var g_lastFallbackSelectedAt = 0;
g_vwSlot.writePointer(ptr(0));

function now() {
    var d = new Date(Date.now() + 8 * 60 * 60 * 1000);

    function pad2(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    function pad3(n) {
        return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n);
    }
    return '[' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '.' + pad3(d
        .getUTCMilliseconds()) + ']';
}

function log(msg) {
    var line = now() + ' ' + msg;
    console.log(line);
}

function emitEvent(type, payload) {
    try {
        payload = payload || {};
        payload.type = type;
        send(payload);
    } catch (e) {}
}

// ==============================
// vy drop queue class detection & selected hook
// ==============================

function isPlausibleItemId(itemId) {
    return itemId > 0 && itemId < 10000000;
}

function isQueueDictType(typeName) {
    if (!typeName) return false;
    return typeName.indexOf('Dictionary') !== -1 &&
        typeName.indexOf('TaskbarHero.EBoxType') !== -1 &&
        typeName.indexOf('TaskbarHero.BoxData') !== -1;
}

function isBoxDataTypeName(typeName) {
    if (!typeName) return false;
    return typeName.indexOf('TaskbarHero.BoxData') !== -1;
}

function isBoxDataListTypeName(typeName) {
    if (!typeName) return false;
    return typeName.indexOf('List') !== -1 && typeName.indexOf('TaskbarHero.BoxData') !== -1;
}

function paramTypesContain(paramTypes, text) {
    paramTypes = paramTypes || [];
    for (var i = 0; i < paramTypes.length; i++) {
        if (String(paramTypes[i] || '').indexOf(text) !== -1) return true;
    }
    return false;
}

function readStr(p) {
    try { if (!p || p.isNull()) return ''; return p.readUtf8String(); } catch(e) { return ''; }
}

function nowMs() { return Date.now(); }

function readBoxDataObscuredInt(boxPtr, key) {
    try {
        var valueOffset = found[key];
        var hiddenOffset = found['ObscuredInt.hiddenValue'];
        var keyOffset = found['ObscuredInt.currentCryptoKey'];
        if (typeof valueOffset !== 'number' || typeof hiddenOffset !== 'number' || typeof keyOffset !== 'number') return 0;
        var boxedHeader = 0x10;
        var hiddenValue = boxPtr.add(valueOffset + hiddenOffset - boxedHeader).readS32();
        var currentCryptoKey = boxPtr.add(valueOffset + keyOffset - boxedHeader).readS32();
        return ((hiddenValue - currentCryptoKey) ^ currentCryptoKey) | 0;
    } catch(e) { return 0; }
}

function readBoxDataPlainItemId(boxPtr) {
    try {
        var raw = boxPtr.add(found['BoxData.itemId'] || 0x54).readS32();
        return isPlausibleItemId(raw) ? raw : 0;
    } catch(e) { return 0; }
}

function readBoxDataRewardItemId(boxPtr) {
    try {
        return boxPtr.add(found['BoxData.rewardItemId'] || 0x68).readS32();
    } catch(e) { return 0; }
}

function readBoxDataItemId(boxPtr) {
    var rewardItemId = readBoxDataObscuredInt(boxPtr, 'BoxData.o_rewardItemId');
    if (isPlausibleItemId(rewardItemId)) return rewardItemId;
    try {
        rewardItemId = readBoxDataRewardItemId(boxPtr);
        if (isPlausibleItemId(rewardItemId)) return rewardItemId;
    } catch(e) {}
    var itemId = readBoxDataObscuredInt(boxPtr, 'BoxData.o_itemId');
    if (isPlausibleItemId(itemId)) return itemId;
    return readBoxDataPlainItemId(boxPtr);
}

function collectQueueFields(klassPtr, classLabel) {
    var offsets = [];
    try {
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        while (true) {
            var field = cgf(klassPtr, iter);
            if (!field || field.isNull()) break;
            var typeName = readStr(tgn(fgt(field)));
            if (!isQueueDictType(typeName)) continue;
            var offset = fgo(field);
            offsets.push(offset);
            console.log('  ' + classLabel + ' queue field @ offset=0x' + offset.toString(16) + ' type=' + typeName);
        }
    } catch(e) {}
    offsets.sort(function(a, b) { return a - b; });
    return offsets;
}

function registerQueueClass(klassPtr, classLabel) {
    var offsets = collectQueueFields(klassPtr, classLabel);
    if (offsets.length === 0) return false;
    found['vwClass'] = klassPtr;
    found['queueClassName'] = classLabel;
    found['queueFieldOffsets'] = offsets;
    console.log('  ' + classLabel + ' selected as drop queue class; queue fields=' + offsets.map(function(o) { return '0x' + o.toString(16); }).join(','));
    logClassMethods(klassPtr, classLabel, 180);
    return true;
}

function findQueueClassByFields() {
    for (var a = 0; a < cnt; a++) {
        var asm = asms.add(a * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var img = aif(asm);
        if (!img || img.isNull()) continue;
        var cc = 0;
        try { cc = iccf(img); } catch(e) { continue; }
        if (cc === 0 || cc > 10000) continue;
        for (var c = 0; c < cc; c++) {
            var k = icf(img, c);
            if (!k || k.isNull()) continue;
            var cn = readStr(cnf(k));
            if (!cn || cn.length > 32) continue;
            var offsets = collectQueueFields(k, cn);
            if (offsets.length >= 2) {
                found['vwClass'] = k;
                found['queueClassName'] = cn;
                found['queueFieldOffsets'] = offsets;
                console.log('  ' + cn + ' selected as drop queue class by field scan; queue fields=' + offsets.map(function(o) { return '0x' + o.toString(16); }).join(','));
                logClassMethods(k, cn, 180);
                return true;
            }
        }
    }
    console.log('  drop queue class field scan: NOT FOUND');
    return false;
}

function logClassMethods(klassPtr, classLabel, limit) {
    var onceKey = 'methodsLogged:' + (classLabel || '?');
    if (found[onceKey]) return false;
    found[onceKey] = true;
    try {
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var count = 0;
        console.log('  ' + classLabel + ' methods scan:');
        while (count < (limit || 160)) {
            var method = cgm(klassPtr, iter);
            if (!method || method.isNull()) break;
            var name = readStr(mgn(method));
            var argc = -1;
            var retName = '';
            var paramTypes = [];
            var rva = '';
            try { argc = mgpc(method); } catch(e) {}
            try { retName = readStr(tgn(mgrt(method))); } catch(e) {}
            try {
                var fp = method.readPointer();
                if (fp && !fp.isNull()) rva = ' RVA=0x' + fp.sub(B).toInt32().toString(16);
            } catch(e) {}
            console.log('    ' + classLabel + '.' + name + '(' + argc + ') -> ' + retName + rva);
            if (!found['vwMethodCandidates']) found['vwMethodCandidates'] = [];
            var candidateFp = method.readPointer();
            if (candidateFp && !candidateFp.isNull()) {
                found['vwMethodCandidates'].push({ name: name, argc: argc, retName: retName, paramTypes: paramTypes, fp: candidateFp });
            }
            count++;
        }
    } catch(e) {
        console.log('  ' + classLabel + ' method scan failed: ' + e);
    }
}

function shouldHookDropCandidate(candidate) {
    if (!candidate || !candidate.fp || candidate.fp.isNull()) return false;
    if (!candidate.name || candidate.name === '.ctor' || candidate.name === '.cctor') return false;
    if (candidate.retName && candidate.retName.indexOf('Void') !== -1) return false;
    if (candidate.retName && candidate.retName.indexOf('String[') !== -1) return false;
    if (candidate.retName && candidate.retName.indexOf('Boolean') !== -1) return false;
    if (candidate.argc > 3) return false;
    return true;
}

function hookVwDropCandidates() {
    var candidates = found['vwMethodCandidates'] || [];
    if (candidates.length === 0) {
        console.log('No vy drop candidates to hook');
        return;
    }
    var hooked = 0;
    for (var i = 0; i < candidates.length; i++) {
        if (hooked >= 80) break;
        var candidate = candidates[i];
        if (!shouldHookDropCandidate(candidate)) continue;
        (function(cand) {
            try {
                Interceptor.attach(cand.fp, {
                    onEnter: function(args) {
                        this._enterTime = nowMs();
                    },
                    onLeave: function(ret) {
                        if (!ret || ret.isNull()) return;
                        try {
                            if (isBoxDataListTypeName(cand.retName)) return;
                            var itemId = readBoxDataItemId(ret);
                            if (!isPlausibleItemId(itemId)) return;
                            var currentMs = nowMs();
                            var retText = String(ret);
                            if (retText === g_lastFallbackSelectedPtr && currentMs - g_lastFallbackSelectedAt < 500) return;
                            g_lastFallbackSelectedPtr = retText;
                            g_lastFallbackSelectedAt = currentMs;
                            g_dropCount++;
                            g_dropHooksTotal++;
                            send({
                                type: 'selected',
                                count: g_dropCount,
                                itemId: itemId,
                                source: cand.name
                            });
                        } catch(e) {}
                    }
                });
                hooked++;
            } catch(e) {
                console.log('ERROR hook vy candidate ' + cand.name + ': ' + e);
            }
        })(candidate);
    }
    console.log('hooked ' + hooked + ' vy drop candidates');
}

function runVyHooks() {
    if (!ENABLE_MEMORY_DROP_HOOKS) {
        console.log('Memory drop hooks disabled; skipping vy scan');
        return;
    }

    for (var a = 0; a < cnt; a++) {
        var asm = asms.add(a * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var img = aif(asm);
        if (!img || img.isNull()) continue;
        if (findFieldOffset(img, 'TaskbarHero', 'BoxData', 'itemId', 'BoxData.itemId')) {
            findFieldOffset(img, 'TaskbarHero', 'BoxData', 'rewardItemId', 'BoxData.rewardItemId');
            findFieldOffset(img, 'TaskbarHero', 'BoxData', 'o_itemId', 'BoxData.o_itemId');
            findFieldOffset(img, 'TaskbarHero', 'BoxData', 'o_rewardItemId', 'BoxData.o_rewardItemId');
            break;
        }
    }
    if (typeof found['BoxData.itemId'] !== 'number') console.log('  TaskbarHero.BoxData.itemId: NOT FOUND; fallback offset=0x54');
    if (typeof found['BoxData.rewardItemId'] !== 'number') console.log('  TaskbarHero.BoxData.rewardItemId: NOT FOUND; fallback offset=0x68');

    for (var b = 0; b < cnt; b++) {
        var asm2 = asms.add(b * Process.pointerSize).readPointer();
        if (!asm2 || asm2.isNull()) continue;
        var img2 = aif(asm2);
        if (!img2 || img2.isNull()) continue;
        if (findFieldOffset(img2, 'CodeStage.AntiCheat.ObscuredTypes', 'ObscuredInt', 'hiddenValue', 'ObscuredInt.hiddenValue')) {
            findFieldOffset(img2, 'CodeStage.AntiCheat.ObscuredTypes', 'ObscuredInt', 'currentCryptoKey', 'ObscuredInt.currentCryptoKey');
            break;
        }
    }

    var queueClassLabel = 'vw';
    for (var c = 0; c < cnt; c++) {
        var asm3 = asms.add(c * Process.pointerSize).readPointer();
        if (!asm3 || asm3.isNull()) continue;
        var img3 = aif(asm3);
        if (!img3 || img3.isNull()) continue;
        var k = cfn(img3, emptyNs, cstr(queueClassLabel));
        if (k && !k.isNull()) {
            registerQueueClass(k, queueClassLabel);
            break;
        }
    }

    if (!found['vwClass']) {
        console.log('  ' + queueClassLabel + ' class not found; scanning drop queue class by fields...');
        findQueueClassByFields();
    }

    if (found['vwMethodCandidates'] && found['vwMethodCandidates'].length > 0) {
        hookVwDropCandidates();
    } else {
        console.log('WARN: no vy method candidates found');
    }
}

function findFieldOffset(img, ns, klass, field, key) {
    var k = cfn(img, cstr(ns), cstr(klass));
    if (!k || k.isNull()) return false;
    var f = cgffn(k, cstr(field));
    if (!f || f.isNull()) return false;
    try {
        var offset = fgo(f);
        found[key || (klass + '.' + field)] = offset;
        console.log('  ' + (ns ? ns + '.' : '') + klass + '.' + field + ' @ offset=0x' + offset.toString(16));
        return true;
    } catch(e) {}
    return false;
}

var ui_statusLastText = '';
var ui_statusLastAt = 0;
var ui_statusCooldowns = {};

function uiStatus(msg) {
    var nowMs = Date.now();
    if (msg === ui_statusLastText && nowMs - ui_statusLastAt < 250) return false;
    ui_statusLastText = msg;
    ui_statusLastAt = nowMs;
    log(msg);
    emitEvent('ui_status', {
        text: msg
    });
    return true;
}

function uiStatusReplace(key, msg) {
    var nowMs = Date.now();
    if (msg === ui_statusLastText && nowMs - ui_statusLastAt < 250) return false;
    ui_statusLastText = msg;
    ui_statusLastAt = nowMs;
    log(msg);
    emitEvent('ui_status', {
        text: msg,
        replaceKey: key || msg
    });
    return true;
}

function uiStatusThrottled(key, msg, cooldownMs) {
    var nowMs = Date.now();
    var cacheKey = key || msg;
    var waitMs = Math.max(0, parseInt(cooldownMs, 10) || 0);
    var lastAt = ui_statusCooldowns[cacheKey] || 0;
    if (waitMs > 0 && nowMs - lastAt < waitMs) return false;
    ui_statusCooldowns[cacheKey] = nowMs;
    return uiStatus(msg);
}

function emitDropEvent(source, itemId) {
    emitEvent('drop_event', {
        source: source,
        item: itemPlain(itemId),
        watched: isWatchedItem(itemId)
    });
}

function emitWatchDetected(source, items) {
    emitEvent('watch_detected', {
        source: source || '掉落列表',
        items: items || []
    });
}

function visibleQueueItems(queues) {
    var visible = [];
    if (!queues) return visible;
    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        if (!q || !q.items) continue;
        var limit = Math.min(q.items.length, watchLimitForQueue(q));
        for (var ii = 0; ii < limit; ii++) {
            visible.push(q.items[ii]);
        }
    }
    return visible;
}

function readRawU32(v) {
    try {
        return ptr(v).toUInt32();
    } catch (e) {
        return 0;
    }
}

function readS32At(p, off) {
    try {
        if (!memoryPtrReadable(p)) return 0;
        return p.add(off).readS32();
    } catch (e) {
        return 0;
    }
}

function isKnownItemId(v) {
    if (!v || v <= 0 || v >= 10000000) return false;
    return !!g_nameMap['' + v];
}

function isBoxId(v) {
    var s = '' + v;
    return !!g_nameMap[s] && (s.indexOf('91') === 0 || s.indexOf('92') === 0 || s.indexOf('93') === 0);
}

function boxKindAndLevel(boxId) {
    var sid = '' + boxId;
    var kind = '箱子';
    if (sid.indexOf('91') === 0) kind = '普通';
    else if (sid.indexOf('92') === 0) kind = '首领';
    else if (sid.indexOf('93') === 0) kind = '活动';
    var level = '';
    var name = g_nameMap[sid] || sid;
    var m = ('' + name).match(/Lv\s*(\d+)/i);
    if (m) level = m[1];
    else if (sid.length >= 5) {
        var raw = parseInt(sid.substring(2, 5), 10);
        if (!isNaN(raw) && raw > 0) level = '' + raw;
    }
    return {
        kind: kind,
        level: level,
        name: name
    };
}

function emitSelectedReward(itemId, source) {
    var item = itemPlain(itemId);
    var box = boxKindAndLevel(g_selectedRewardLastBoxId);
    g_selectedRewardCount++;
    var text = '[箱子掉落] Lv' + (box.level || '?') + ' ' + box.kind + ' -> ' + item.name + ' ' + item.grade +
        (item.watched ? '  *监控命中*' : '');
    log(text);
    emitEvent('selected_reward', {
        source: source || '箱子掉落',
        item: item,
        boxId: '' + g_selectedRewardLastBoxId,
        boxName: box.name,
        boxKind: box.kind,
        boxLevel: box.level,
        watched: item.watched,
        text: text
    });
    if (item.watched) {
        emitDropEvent('实际开箱', itemId);
        uiOnItemDropped(itemId, '实际开箱', true);
    }
}

function captureSelectedRewardCandidate(itemId, source) {
    if (!isKnownItemId(itemId) || isBoxId(itemId)) return false;
    var nowMs = Date.now();
    var key = g_selectedRewardLastBoxId + '|' + itemId;
    if (key === g_selectedRewardLastKey && nowMs - g_selectedRewardLastAt < SELECTED_REWARD_EMIT_GAP_MS) return true;
    g_selectedRewardLastKey = key;
    g_selectedRewardLastAt = nowMs;
    g_selectedRewardPending = {
        itemId: itemId,
        boxId: '' + g_selectedRewardLastBoxId,
        at: nowMs,
        source: source || '箱子处理'
    };
    return true;
}

function confirmSelectedRewardForBox(boxId, source) {
    if (!g_selectedRewardPending) return false;
    var nowMs = Date.now();
    if (nowMs - g_selectedRewardPending.at > SELECTED_REWARD_BOX_WINDOW_MS) {
        g_selectedRewardPending = null;
        return false;
    }
    g_selectedRewardLastBoxId = '' + boxId;
    var itemId = g_selectedRewardPending.itemId;
    g_selectedRewardPending = null;
    g_selectedRewardActiveUntil = 0;
    emitSelectedReward(itemId, source || '箱子掉落');
    return true;
}

function readSelectedRewardCandidate(ret, ctx) {
    var candidates = [];
    if (ctx && ctx.selectedCandidatePtr) candidates.push({ p: ctx.selectedCandidatePtr, off: 0x3c });
    if (ret && !ret.isNull()) {
        candidates.push({ p: ret, off: 0x3c });
        candidates.push({ p: ret, off: 0x68 });
    }
    for (var i = 0; i < candidates.length; i++) {
        var itemId = readS32At(candidates[i].p, candidates[i].off);
        if (isKnownItemId(itemId) && !isBoxId(itemId)) return itemId;
    }
    return 0;
}

function rawKnownItem(v) {
    var n = readRawU32(v);
    if (isKnownItemId(n) && !isBoxId(n)) return n;
    return 0;
}

function fixedSelectedRewardHit(methodName, args) {
    var n = 0;
    if (methodName === 'itg') {
        n = rawKnownItem(args[4]);
        if (n) return { itemId: n, offset: 'arg4+raw' };
    }
    if (methodName === 'itz') {
        n = rawKnownItem(args[1]);
        if (n) return { itemId: n, offset: 'arg1+raw' };
    }
    if (methodName === 'itq') {
        var p = args[4];
        var offsets = [0x50, 0x60, 0xa4, 0xb0];
        for (var i = 0; i < offsets.length; i++) {
            n = readS32At(p, offsets[i]);
            if (isKnownItemId(n) && !isBoxId(n)) return { itemId: n, offset: 'arg4+0x' + offsets[i].toString(16) };
        }
    }
    return null;
}

function fixedSelectedBoxHit(methodName, args) {
    var n = readRawU32(args[0]);
    if (isBoxId(n)) return { boxId: n, where: 'arg0+raw' };
    if (methodName === 'iun') {
        n = readS32At(args[0], 0x1a4);
        if (isBoxId(n)) return { boxId: n, where: 'arg0+0x1a4' };
        n = readS32At(args[4], 0x1a4);
        if (isBoxId(n)) return { boxId: n, where: 'arg4+0x1a4' };
    }
    return null;
}

function loadConfig() {
    var defaults = {
        display: {
            normalCount: 10,
            bossCount: 5,
            actCount: 10,
            clickDelayMs: 3000,
            pressIntervalMs: 450,
            roleDeployDelayMs: 800,
            switchMode: 'time',
            loopPauseEvery: 0,
            loopPauseMs: 0,
            autoDepositEnabled: false,
            autoDepositMinutes: 30,
            clearBeforePrint: true
        },
        watch: {
            enabled: true,
            names: [],
            ids: [],
            matchMode: 'exact',
            highlightBackgroundAnsi: '\x1b[30;48;5;226m'
        },
        record: {
            rows: [
                { label: '低等级箱子关卡', delay: 0.1 },
                { label: '高等级箱子关卡', delay: 0.1 },
                { label: '仓库按钮', delay: 0.4 },
                { label: '放入仓库', delay: 0.4 },
                { label: '仓库1', delay: 0.4 },
                { label: '仓库2', delay: 0.4 },
                { label: '仓库3', delay: 0.4 },
                { label: '仓库4', delay: 0.4 },
                { label: '仓库5', delay: 0.4 },
                { label: '仓库6', delay: 0.4 },
                { label: '仓库7', delay: 0.4 },
                { label: '难度1选择', delay: 0.25 },
                { label: '点击章节', delay: 0.25 },
                { label: '目标关卡', delay: 0.25 },
                { label: '难度2选择', delay: 0.25 },
                { label: '点击章节', delay: 0.25 },
                { label: '目标关卡', delay: 0.25 }
            ]
        }
    };

    try {
        var f = new File('drop_items_config.json', 'r');
        var txt = '';
        var chunk;
        while ((chunk = f.readLine()) !== null) txt += chunk + '\n';
        f.close();
        var cfg = JSON.parse(txt);
        cfg.display = cfg.display || {};
        cfg.watch = cfg.watch || {};
        cfg.display.normalCount = cfg.display.normalCount || defaults.display.normalCount;
        cfg.display.bossCount = cfg.display.bossCount || defaults.display.bossCount;
        cfg.display.actCount = cfg.display.actCount || defaults.display.actCount;
        cfg.display.clickDelayMs = parseInt(cfg.display.clickDelayMs, 10);
        if (isNaN(cfg.display.clickDelayMs)) cfg.display.clickDelayMs = defaults.display.clickDelayMs;
        cfg.display.pressIntervalMs = parseInt(cfg.display.pressIntervalMs, 10);
        if (isNaN(cfg.display.pressIntervalMs)) cfg.display.pressIntervalMs = defaults.display.pressIntervalMs;
        cfg.display.roleDeployDelayMs = parseInt(cfg.display.roleDeployDelayMs, 10);
        if (isNaN(cfg.display.roleDeployDelayMs)) cfg.display.roleDeployDelayMs = defaults.display.roleDeployDelayMs;
        cfg.display.switchMode = 'time';
        cfg.display.loopPauseEvery = parseInt(cfg.display.loopPauseEvery, 10);
        if (isNaN(cfg.display.loopPauseEvery)) cfg.display.loopPauseEvery = defaults.display.loopPauseEvery;
        cfg.display.loopPauseMs = parseInt(cfg.display.loopPauseMs, 10);
        if (isNaN(cfg.display.loopPauseMs)) cfg.display.loopPauseMs = defaults.display.loopPauseMs;
        cfg.display.autoDepositEnabled = false;
        cfg.display.autoDepositMinutes = parseInt(cfg.display.autoDepositMinutes, 10);
        if (isNaN(cfg.display.autoDepositMinutes) || cfg.display.autoDepositMinutes <= 0) cfg.display.autoDepositMinutes = defaults.display.autoDepositMinutes;
        cfg.display.clearBeforePrint = cfg.display.clearBeforePrint !== false;
        cfg.watch.enabled = cfg.watch.enabled !== false;
        cfg.watch.names = cfg.watch.names || [];
        cfg.watch.ids = cfg.watch.ids || [];
        cfg.watch.matchMode = cfg.watch.matchMode || defaults.watch.matchMode;
        cfg.watch.highlightBackgroundAnsi = cfg.watch.highlightBackgroundAnsi || defaults.watch.highlightBackgroundAnsi;
        cfg.record = cfg.record || {};
        cfg.record.rows = Array.isArray(cfg.record.rows) && cfg.record.rows.length ? cfg.record.rows : defaults.record.rows;
        for (var r = cfg.record.rows.length; r < defaults.record.rows.length; r++) {
            cfg.record.rows.push(defaults.record.rows[r]);
        }
        for (var i = 0; i < cfg.record.rows.length; i++) {
            var row = cfg.record.rows[i] || {};
            row.label = '' + (row.label || ('录制UI #' + (i + 1)));
            var delay = parseFloat(row.delay);
            row.delay = isNaN(delay) ? 0.1 : Math.max(0, delay);
            cfg.record.rows[i] = row;
        }
        return cfg;
    } catch (e) {
        console.log('[config] drop_items_config.json not loaded, using defaults: ' + e);
        return defaults;
    }
}

function memoryPtrReadable(p) {
    try {
        if (!p || p.isNull()) return false;
        var r = Process.findRangeByAddress(p);
        return !!(r && r.protection.indexOf('r') !== -1);
    } catch (e) {
        return false;
    }
}

function readBexlQueuesFromBexl(bexl) {
    if (!memoryPtrReadable(bexl)) return [];
    var ep = bexl.add(0x18).readPointer();
    var count = bexl.add(0x20).readS32();
    if (!memoryPtrReadable(ep) || count <= 0 || count > 16) return [];
    var results = [];
    for (var i = 0; i < count; i++) {
        var entry = ep.add(0x20 + i * 24);
        var ebt = entry.add(0x08).readS32();
        var lp = entry.add(0x10).readPointer();
        if (ebt < 0 || ebt > 8 || !memoryPtrReadable(lp)) continue;
        var arr = lp.add(0x10).readPointer();
        var sz = lp.add(0x18).readS32();
        if (!memoryPtrReadable(arr) || sz <= 0 || sz > 512) continue;
        var ids = [];
        for (var j = 0; j < Math.min(sz, 64); j++) {
            var bd = arr.add(0x20 + j * 8).readPointer();
            if (!memoryPtrReadable(bd)) continue;
            var itemId = bd.add(0x3C).readS32();
            if (itemId > 0 && itemId < 10000000) ids.push(itemId);
        }
        if (ids.length === 0) continue;
        var label = ebt === 0 ? '\u666e\u901a\u6389\u843d' : ebt === 1 ? '\u9996\u9886\u6389\u843d' : ebt === 2 ?
            'ACT\u6389\u843d' : '\u672a\u77e5(' + ebt + ')';
        results.push({
            eboxType: ebt,
            label: label,
            items: ids,
            size: sz,
            listPtr: lp
        });
    }
    return results.sort(function(a, b) {
        return a.eboxType - b.eboxType;
    });
}

function tryCacheBexlOwner(candidate, label) {
    if (!memoryPtrReadable(candidate)) return false;
    var offsets = [0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50];
    for (var oi = 0; oi < offsets.length; oi++) {
        try {
            var bexl = candidate.add(offsets[oi]).readPointer();
            var queues = readBexlQueuesFromBexl(bexl);
            if (queues.length > 0) {
                g_vw = candidate;
                g_vwBexlOffset = offsets[oi];
                g_vwIsBexlDirect = false;
                log('[memory] 找到掉落管理对象 ' + label + ' owner=' + candidate + ' bexlOffset=0x' + offsets[oi].toString(16) + ' queues=' + queues.length);
                return true;
            }
        } catch (e) {}
    }
    try {
        var directQueues = readBexlQueuesFromBexl(candidate);
        if (directQueues.length > 0) {
            g_vw = candidate;
            g_vwBexlOffset = 0;
            g_vwIsBexlDirect = true;
            log('[memory] 找到bexl对象 ' + label + ' bexl=' + candidate + ' queues=' + directQueues.length);
            return true;
        }
    } catch (e) {}
    return false;
}

function hasCachedBexlOwner() {
    try {
        if (g_vw && !g_vw.isNull()) {
            var cachedBexl = g_vwIsBexlDirect ? g_vw : g_vw.add(g_vwBexlOffset).readPointer();
            if (readBexlQueuesFromBexl(cachedBexl).length > 0) return true;
        }
    } catch (e) {}
    return false;
}

function scanBexlOwnerFromArgs(label, args, maxArgs, minIntervalMs) {
    if (hasCachedBexlOwner()) return true;
    minIntervalMs = minIntervalMs || 1200;
    var nowMs = Date.now();
    if (nowMs - g_bexlOwnerScanLastMs < minIntervalMs) return false;
    g_bexlOwnerScanLastMs = nowMs;
    maxArgs = maxArgs || 8;
    for (var i = 0; i < maxArgs; i++) {
        try {
            var p = args[i];
            if (tryCacheBexlOwner(p, label + '.arg' + i)) return true;
        } catch (e) {}
    }
    return false;
}

function scanBexlOwnerFromContext(label, context, includeStack, minIntervalMs) {
    try {
        if (hasCachedBexlOwner()) return true;
        if (!context) return false;
        minIntervalMs = minIntervalMs || 2500;
        var nowMs = Date.now();
        if (nowMs - g_bexlOwnerDeepScanLastMs < minIntervalMs) return false;
        g_bexlOwnerDeepScanLastMs = nowMs;
        var regs = ['rcx', 'rdx', 'r8', 'r9', 'rax', 'rbx', 'rsi', 'rdi', 'r12', 'r13', 'r14', 'r15'];
        for (var i = 0; i < regs.length; i++) {
            try {
                var rp = context[regs[i]];
                if (rp && tryCacheBexlOwner(ptr(rp), label + '.' + regs[i])) return true;
            } catch (e) {}
        }
        if (!includeStack) return false;
        var sp = context.rsp || context.esp;
        if (!sp) return false;
        sp = ptr(sp);
        for (var off = 0x20; off <= 0xc0; off += Process.pointerSize) {
            try {
                var candidate = sp.add(off).readPointer();
                if (tryCacheBexlOwner(candidate, label + '.stack+0x' + off.toString(16))) return true;
            } catch (e) {}
        }
    } catch (e) {}
    return false;
}

function readBexlQueues(debugReason) {
    function debug(msg) {
        if (!debugReason) return;
        var text = '[memory] ' + debugReason + ': ' + msg;
        if (text === g_bexlLastDebug) return;
        g_bexlLastDebug = text;
        log(text);
    }
    if (!g_vw || g_vw.isNull()) {
        debug('g_vw为空，尚未从jsq/jsl拿到掉落管理对象');
        return [];
    }
    try {
        var bexl = g_vwIsBexlDirect ? g_vw : g_vw.add(g_vwBexlOffset).readPointer();
        if (!bexl || bexl.isNull()) {
            debug('g_vw+0x' + g_vwBexlOffset.toString(16) + '为空，bexl偏移可能变化 vw=' + g_vw);
            return [];
        }
        var results = readBexlQueuesFromBexl(bexl);
        if (results.length === 0) debug('未读到有效掉落列表 owner=' + g_vw + ' direct=' + g_vwIsBexlDirect + ' offset=0x' + g_vwBexlOffset.toString(16));
        return results;
    } catch (e) {
        debug('读取异常：' + e);
        return [];
    }
}

// 计算字符串显示宽度 (中文=2, ANSI码=0, 其他=1)
function dispWidth(str) {
    var clean = str.replace(/\x1b\[[0-9;]*m/g, '');
    var w = 0;
    for (var i = 0; i < clean.length; i++) {
        var c = clean.charCodeAt(i);
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) w += 2;
        else w += 1;
    }
    return w;
}

function padRight(str, width) {
    var w = dispWidth(str);
    return str + ' '.repeat(Math.max(0, width - w));
}

// ======== 物品名称 & 等级颜色映射 (来源: taskbarhero.wiki) ========
var GRADE_ANSI = {
    'COMMON': '\x1b[38;5;253m', // #e4e4e4 灰白
    'UNCOMMON': '\x1b[38;5;119m', // #54fc0c 亮绿
    'RARE': '\x1b[38;5;27m', // #0c6cfc 蓝
    'LEGENDARY': '\x1b[38;5;208m', // #fc9c0c 橙
    'IMMORTAL': '\x1b[38;5;196m', // #fc2424 红
    'ARCANA': '\x1b[38;5;129m', // #b40cfc 紫
    'BEYOND': '\x1b[38;5;197m', // #fc246c 粉红
    'CELESTIAL': '\x1b[38;5;81m', // #6ccce4 青
    'DIVINE': '\x1b[38;5;221m', // #fce454 金黄
    'COSMIC': '\x1b[38;5;255m', // #fcfcfc 纯白
};
var ANSI_RESET = '\x1b[0m';
var ITEM_NAME_COL_WIDTH = 18;
var ITEM_GRADE_COL_WIDTH = 8;

var g_gradeChinese = {
    'COMMON': '\u666e\u901a',
    'UNCOMMON': '\u7f55\u89c1',
    'RARE': '\u7a00\u6709',
    'LEGENDARY': '\u4f20\u5947',
    'IMMORTAL': '\u4e0d\u673D',
    'ARCANA': '\u81f3\u5b9d',
    'BEYOND': '\u8d85\u51e1',
    'CELESTIAL': '\u5929\u754c',
    'DIVINE': '\u795e\u5723',
    'COSMIC': '\u5b87\u5b99'
};

var g_gradeMap = {
    "110001": "COMMON",
    "110002": "COMMON",
    "110003": "COMMON",
    "110004": "COMMON",
    "110005": "COMMON",
    "111001": "UNCOMMON",
    "111002": "UNCOMMON",
    "111003": "UNCOMMON",
    "111004": "UNCOMMON",
    "112001": "RARE",
    "112002": "RARE",
    "112003": "RARE",
    "112004": "RARE",
    "112005": "RARE",
    "113001": "LEGENDARY",
    "113002": "LEGENDARY",
    "113003": "LEGENDARY",
    "113004": "LEGENDARY",
    "114001": "IMMORTAL",
    "114002": "IMMORTAL",
    "114003": "IMMORTAL",
    "114004": "IMMORTAL",
    "115001": "ARCANA",
    "115002": "ARCANA",
    "115003": "ARCANA",
    "115004": "ARCANA",
    "116001": "BEYOND",
    "116002": "BEYOND",
    "116003": "BEYOND",
    "116004": "BEYOND",
    "117001": "CELESTIAL",
    "117002": "CELESTIAL",
    "118001": "DIVINE",
    "118002": "DIVINE",
    "119001": "COSMIC",
    "119002": "COSMIC",
    "120001": "COMMON",
    "120002": "COMMON",
    "120003": "COMMON",
    "121001": "UNCOMMON",
    "121002": "UNCOMMON",
    "121003": "UNCOMMON",
    "121004": "UNCOMMON",
    "122001": "RARE",
    "122002": "RARE",
    "122003": "RARE",
    "122004": "RARE",
    "123001": "LEGENDARY",
    "123002": "LEGENDARY",
    "123003": "LEGENDARY",
    "123004": "LEGENDARY",
    "124001": "IMMORTAL",
    "124002": "IMMORTAL",
    "124003": "IMMORTAL",
    "124004": "IMMORTAL",
    "125001": "ARCANA",
    "125002": "ARCANA",
    "125003": "ARCANA",
    "125004": "ARCANA",
    "126001": "BEYOND",
    "126002": "BEYOND",
    "126003": "BEYOND",
    "126004": "BEYOND",
    "127001": "CELESTIAL",
    "127002": "CELESTIAL",
    "128001": "DIVINE",
    "128002": "DIVINE",
    "129001": "COSMIC",
    "129002": "COSMIC",
    "130001": "COMMON",
    "131001": "UNCOMMON",
    "132001": "RARE",
    "133001": "LEGENDARY",
    "134001": "IMMORTAL",
    "135001": "ARCANA",
    "136001": "BEYOND",
    "137001": "CELESTIAL",
    "138001": "DIVINE",
    "139001": "COSMIC",
    "140001": "COMMON",
    "140002": "COMMON",
    "140003": "COMMON",
    "140004": "COMMON",
    "141001": "UNCOMMON",
    "141002": "UNCOMMON",
    "142001": "RARE",
    "142002": "RARE",
    "143001": "LEGENDARY",
    "143002": "LEGENDARY",
    "144001": "IMMORTAL",
    "144002": "IMMORTAL",
    "145001": "ARCANA",
    "145002": "ARCANA",
    "146001": "BEYOND",
    "146002": "BEYOND",
    "147001": "CELESTIAL",
    "147002": "CELESTIAL",
    "148001": "DIVINE",
    "148002": "DIVINE",
    "149001": "COSMIC",
    "149002": "COSMIC",
    "150001": "COMMON",
    "150002": "UNCOMMON",
    "150003": "RARE",
    "150004": "LEGENDARY",
    "150005": "IMMORTAL",
    "150006": "ARCANA",
    "150007": "BEYOND",
    "150008": "CELESTIAL",
    "150009": "DIVINE",
    "150010": "COSMIC",
    "160001": "COMMON",
    "160002": "UNCOMMON",
    "160003": "RARE",
    "160004": "LEGENDARY",
    "160005": "IMMORTAL",
    "160006": "ARCANA",
    "160007": "BEYOND",
    "160008": "CELESTIAL",
    "160009": "DIVINE",
    "160010": "COSMIC",
    "190001": "IMMORTAL",
    "190002": "ARCANA",
    "190003": "BEYOND",
    "190004": "CELESTIAL",
    "300001": "COMMON",
    "300002": "COMMON",
    "300003": "COMMON",
    "300004": "COMMON",
    "300005": "COMMON",
    "300006": "COMMON",
    "300007": "COMMON",
    "300008": "COMMON",
    "300009": "COMMON",
    "300010": "COMMON",
    "300011": "COMMON",
    "300012": "COMMON",
    "300013": "COMMON",
    "300014": "COMMON",
    "300015": "COMMON",
    "300016": "COMMON",
    "300017": "COMMON",
    "300018": "COMMON",
    "300019": "COMMON",
    "300020": "COMMON",
    "301011": "UNCOMMON",
    "301021": "UNCOMMON",
    "301031": "UNCOMMON",
    "301041": "UNCOMMON",
    "301051": "UNCOMMON",
    "301061": "UNCOMMON",
    "301071": "UNCOMMON",
    "301081": "UNCOMMON",
    "301091": "UNCOMMON",
    "301101": "UNCOMMON",
    "301111": "UNCOMMON",
    "301121": "UNCOMMON",
    "301131": "UNCOMMON",
    "301141": "UNCOMMON",
    "301151": "UNCOMMON",
    "301161": "UNCOMMON",
    "301171": "UNCOMMON",
    "301181": "UNCOMMON",
    "301191": "UNCOMMON",
    "302011": "RARE",
    "302021": "RARE",
    "302031": "RARE",
    "302041": "RARE",
    "302051": "RARE",
    "302061": "RARE",
    "302071": "RARE",
    "302081": "RARE",
    "302091": "RARE",
    "302101": "RARE",
    "302111": "RARE",
    "302121": "RARE",
    "302131": "RARE",
    "302141": "RARE",
    "302151": "RARE",
    "302161": "RARE",
    "302171": "RARE",
    "302181": "RARE",
    "302191": "RARE",
    "303011": "LEGENDARY",
    "303021": "LEGENDARY",
    "303031": "LEGENDARY",
    "303041": "LEGENDARY",
    "303051": "LEGENDARY",
    "303061": "LEGENDARY",
    "303071": "LEGENDARY",
    "303081": "LEGENDARY",
    "303091": "LEGENDARY",
    "303101": "LEGENDARY",
    "303111": "LEGENDARY",
    "303121": "LEGENDARY",
    "303131": "LEGENDARY",
    "303141": "LEGENDARY",
    "303151": "LEGENDARY",
    "303161": "LEGENDARY",
    "303171": "LEGENDARY",
    "303181": "LEGENDARY",
    "303191": "LEGENDARY",
    "304011": "IMMORTAL",
    "304021": "IMMORTAL",
    "304031": "IMMORTAL",
    "304041": "IMMORTAL",
    "304051": "IMMORTAL",
    "304061": "IMMORTAL",
    "304071": "IMMORTAL",
    "304081": "IMMORTAL",
    "304091": "IMMORTAL",
    "304101": "IMMORTAL",
    "304111": "IMMORTAL",
    "304121": "IMMORTAL",
    "304131": "IMMORTAL",
    "304141": "IMMORTAL",
    "304151": "IMMORTAL",
    "304161": "IMMORTAL",
    "304171": "IMMORTAL",
    "304181": "IMMORTAL",
    "304191": "IMMORTAL",
    "305041": "ARCANA",
    "305051": "ARCANA",
    "305061": "ARCANA",
    "305071": "ARCANA",
    "305081": "ARCANA",
    "305091": "ARCANA",
    "305101": "ARCANA",
    "305111": "ARCANA",
    "305121": "ARCANA",
    "305131": "ARCANA",
    "305141": "ARCANA",
    "305151": "ARCANA",
    "305161": "ARCANA",
    "305171": "ARCANA",
    "305181": "ARCANA",
    "305191": "ARCANA",
    "306061": "BEYOND",
    "306071": "BEYOND",
    "306081": "BEYOND",
    "306091": "BEYOND",
    "306101": "BEYOND",
    "306111": "BEYOND",
    "306121": "BEYOND",
    "306131": "BEYOND",
    "306141": "BEYOND",
    "306151": "BEYOND",
    "306161": "BEYOND",
    "306171": "BEYOND",
    "306181": "BEYOND",
    "306191": "BEYOND",
    "307081": "CELESTIAL",
    "307091": "CELESTIAL",
    "307101": "CELESTIAL",
    "307111": "CELESTIAL",
    "307121": "CELESTIAL",
    "307131": "CELESTIAL",
    "307141": "CELESTIAL",
    "307151": "CELESTIAL",
    "307161": "CELESTIAL",
    "307171": "CELESTIAL",
    "307181": "CELESTIAL",
    "307191": "CELESTIAL",
    "308101": "DIVINE",
    "308111": "DIVINE",
    "308121": "DIVINE",
    "308131": "DIVINE",
    "308141": "DIVINE",
    "308151": "DIVINE",
    "308161": "DIVINE",
    "308171": "DIVINE",
    "308181": "DIVINE",
    "308191": "DIVINE",
    "309121": "COSMIC",
    "309131": "COSMIC",
    "309141": "COSMIC",
    "309151": "COSMIC",
    "309161": "COSMIC",
    "309171": "COSMIC",
    "309181": "COSMIC",
    "309191": "COSMIC",
    "310001": "COMMON",
    "310002": "COMMON",
    "310003": "COMMON",
    "310004": "COMMON",
    "310005": "COMMON",
    "310006": "COMMON",
    "310007": "COMMON",
    "310008": "COMMON",
    "310009": "COMMON",
    "310010": "COMMON",
    "310011": "COMMON",
    "310012": "COMMON",
    "310013": "COMMON",
    "310014": "COMMON",
    "310015": "COMMON",
    "310016": "COMMON",
    "310017": "COMMON",
    "310018": "COMMON",
    "310019": "COMMON",
    "310020": "COMMON",
    "311011": "UNCOMMON",
    "311021": "UNCOMMON",
    "311031": "UNCOMMON",
    "311041": "UNCOMMON",
    "311051": "UNCOMMON",
    "311061": "UNCOMMON",
    "311071": "UNCOMMON",
    "311081": "UNCOMMON",
    "311091": "UNCOMMON",
    "311101": "UNCOMMON",
    "311111": "UNCOMMON",
    "311121": "UNCOMMON",
    "311131": "UNCOMMON",
    "311141": "UNCOMMON",
    "311151": "UNCOMMON",
    "311161": "UNCOMMON",
    "311171": "UNCOMMON",
    "311181": "UNCOMMON",
    "311191": "UNCOMMON",
    "312011": "RARE",
    "312021": "RARE",
    "312031": "RARE",
    "312041": "RARE",
    "312051": "RARE",
    "312061": "RARE",
    "312071": "RARE",
    "312081": "RARE",
    "312091": "RARE",
    "312101": "RARE",
    "312111": "RARE",
    "312121": "RARE",
    "312131": "RARE",
    "312141": "RARE",
    "312151": "RARE",
    "312161": "RARE",
    "312171": "RARE",
    "312181": "RARE",
    "312191": "RARE",
    "313011": "LEGENDARY",
    "313021": "LEGENDARY",
    "313031": "LEGENDARY",
    "313041": "LEGENDARY",
    "313051": "LEGENDARY",
    "313061": "LEGENDARY",
    "313071": "LEGENDARY",
    "313081": "LEGENDARY",
    "313091": "LEGENDARY",
    "313101": "LEGENDARY",
    "313111": "LEGENDARY",
    "313121": "LEGENDARY",
    "313131": "LEGENDARY",
    "313141": "LEGENDARY",
    "313151": "LEGENDARY",
    "313161": "LEGENDARY",
    "313171": "LEGENDARY",
    "313181": "LEGENDARY",
    "313191": "LEGENDARY",
    "314011": "IMMORTAL",
    "314021": "IMMORTAL",
    "314031": "IMMORTAL",
    "314041": "IMMORTAL",
    "314051": "IMMORTAL",
    "314061": "IMMORTAL",
    "314071": "IMMORTAL",
    "314081": "IMMORTAL",
    "314091": "IMMORTAL",
    "314101": "IMMORTAL",
    "314111": "IMMORTAL",
    "314121": "IMMORTAL",
    "314131": "IMMORTAL",
    "314141": "IMMORTAL",
    "314151": "IMMORTAL",
    "314161": "IMMORTAL",
    "314171": "IMMORTAL",
    "314181": "IMMORTAL",
    "314191": "IMMORTAL",
    "315041": "ARCANA",
    "315051": "ARCANA",
    "315061": "ARCANA",
    "315071": "ARCANA",
    "315081": "ARCANA",
    "315091": "ARCANA",
    "315101": "ARCANA",
    "315111": "ARCANA",
    "315121": "ARCANA",
    "315131": "ARCANA",
    "315141": "ARCANA",
    "315151": "ARCANA",
    "315161": "ARCANA",
    "315171": "ARCANA",
    "315181": "ARCANA",
    "315191": "ARCANA",
    "316061": "BEYOND",
    "316071": "BEYOND",
    "316081": "BEYOND",
    "316091": "BEYOND",
    "316101": "BEYOND",
    "316111": "BEYOND",
    "316121": "BEYOND",
    "316131": "BEYOND",
    "316141": "BEYOND",
    "316151": "BEYOND",
    "316161": "BEYOND",
    "316171": "BEYOND",
    "316181": "BEYOND",
    "316191": "BEYOND",
    "317081": "CELESTIAL",
    "317091": "CELESTIAL",
    "317101": "CELESTIAL",
    "317111": "CELESTIAL",
    "317121": "CELESTIAL",
    "317131": "CELESTIAL",
    "317141": "CELESTIAL",
    "317151": "CELESTIAL",
    "317161": "CELESTIAL",
    "317171": "CELESTIAL",
    "317181": "CELESTIAL",
    "317191": "CELESTIAL",
    "318101": "DIVINE",
    "318111": "DIVINE",
    "318121": "DIVINE",
    "318131": "DIVINE",
    "318141": "DIVINE",
    "318151": "DIVINE",
    "318161": "DIVINE",
    "318171": "DIVINE",
    "318181": "DIVINE",
    "318191": "DIVINE",
    "319121": "COSMIC",
    "319131": "COSMIC",
    "319141": "COSMIC",
    "319151": "COSMIC",
    "319161": "COSMIC",
    "319171": "COSMIC",
    "319181": "COSMIC",
    "319191": "COSMIC",
    "320001": "COMMON",
    "320002": "COMMON",
    "320003": "COMMON",
    "320004": "COMMON",
    "320005": "COMMON",
    "320006": "COMMON",
    "320007": "COMMON",
    "320008": "COMMON",
    "320009": "COMMON",
    "320010": "COMMON",
    "320011": "COMMON",
    "320012": "COMMON",
    "320013": "COMMON",
    "320014": "COMMON",
    "320015": "COMMON",
    "320016": "COMMON",
    "320017": "COMMON",
    "320018": "COMMON",
    "320019": "COMMON",
    "320020": "COMMON",
    "321011": "UNCOMMON",
    "321021": "UNCOMMON",
    "321031": "UNCOMMON",
    "321041": "UNCOMMON",
    "321051": "UNCOMMON",
    "321061": "UNCOMMON",
    "321071": "UNCOMMON",
    "321081": "UNCOMMON",
    "321091": "UNCOMMON",
    "321101": "UNCOMMON",
    "321111": "UNCOMMON",
    "321121": "UNCOMMON",
    "321131": "UNCOMMON",
    "321141": "UNCOMMON",
    "321151": "UNCOMMON",
    "321161": "UNCOMMON",
    "321171": "UNCOMMON",
    "321181": "UNCOMMON",
    "321191": "UNCOMMON",
    "322011": "RARE",
    "322021": "RARE",
    "322031": "RARE",
    "322041": "RARE",
    "322051": "RARE",
    "322061": "RARE",
    "322071": "RARE",
    "322081": "RARE",
    "322091": "RARE",
    "322101": "RARE",
    "322111": "RARE",
    "322121": "RARE",
    "322131": "RARE",
    "322141": "RARE",
    "322151": "RARE",
    "322161": "RARE",
    "322171": "RARE",
    "322181": "RARE",
    "322191": "RARE",
    "323011": "LEGENDARY",
    "323021": "LEGENDARY",
    "323031": "LEGENDARY",
    "323041": "LEGENDARY",
    "323051": "LEGENDARY",
    "323061": "LEGENDARY",
    "323071": "LEGENDARY",
    "323081": "LEGENDARY",
    "323091": "LEGENDARY",
    "323101": "LEGENDARY",
    "323111": "LEGENDARY",
    "323121": "LEGENDARY",
    "323131": "LEGENDARY",
    "323141": "LEGENDARY",
    "323151": "LEGENDARY",
    "323161": "LEGENDARY",
    "323171": "LEGENDARY",
    "323181": "LEGENDARY",
    "323191": "LEGENDARY",
    "324011": "IMMORTAL",
    "324021": "IMMORTAL",
    "324031": "IMMORTAL",
    "324041": "IMMORTAL",
    "324051": "IMMORTAL",
    "324061": "IMMORTAL",
    "324071": "IMMORTAL",
    "324081": "IMMORTAL",
    "324091": "IMMORTAL",
    "324101": "IMMORTAL",
    "324111": "IMMORTAL",
    "324121": "IMMORTAL",
    "324131": "IMMORTAL",
    "324141": "IMMORTAL",
    "324151": "IMMORTAL",
    "324161": "IMMORTAL",
    "324171": "IMMORTAL",
    "324181": "IMMORTAL",
    "324191": "IMMORTAL",
    "325041": "ARCANA",
    "325051": "ARCANA",
    "325061": "ARCANA",
    "325071": "ARCANA",
    "325081": "ARCANA",
    "325091": "ARCANA",
    "325101": "ARCANA",
    "325111": "ARCANA",
    "325121": "ARCANA",
    "325131": "ARCANA",
    "325141": "ARCANA",
    "325151": "ARCANA",
    "325161": "ARCANA",
    "325171": "ARCANA",
    "325181": "ARCANA",
    "325191": "ARCANA",
    "326061": "BEYOND",
    "326071": "BEYOND",
    "326081": "BEYOND",
    "326091": "BEYOND",
    "326101": "BEYOND",
    "326111": "BEYOND",
    "326121": "BEYOND",
    "326131": "BEYOND",
    "326141": "BEYOND",
    "326151": "BEYOND",
    "326161": "BEYOND",
    "326171": "BEYOND",
    "326181": "BEYOND",
    "326191": "BEYOND",
    "327081": "CELESTIAL",
    "327091": "CELESTIAL",
    "327101": "CELESTIAL",
    "327111": "CELESTIAL",
    "327121": "CELESTIAL",
    "327131": "CELESTIAL",
    "327141": "CELESTIAL",
    "327151": "CELESTIAL",
    "327161": "CELESTIAL",
    "327171": "CELESTIAL",
    "327181": "CELESTIAL",
    "327191": "CELESTIAL",
    "328101": "DIVINE",
    "328111": "DIVINE",
    "328121": "DIVINE",
    "328131": "DIVINE",
    "328141": "DIVINE",
    "328151": "DIVINE",
    "328161": "DIVINE",
    "328171": "DIVINE",
    "328181": "DIVINE",
    "328191": "DIVINE",
    "329121": "COSMIC",
    "329131": "COSMIC",
    "329141": "COSMIC",
    "329151": "COSMIC",
    "329161": "COSMIC",
    "329171": "COSMIC",
    "329181": "COSMIC",
    "329191": "COSMIC",
    "330001": "COMMON",
    "330002": "COMMON",
    "330003": "COMMON",
    "330004": "COMMON",
    "330005": "COMMON",
    "330006": "COMMON",
    "330007": "COMMON",
    "330008": "COMMON",
    "330009": "COMMON",
    "330010": "COMMON",
    "330011": "COMMON",
    "330012": "COMMON",
    "330013": "COMMON",
    "330014": "COMMON",
    "330015": "COMMON",
    "330016": "COMMON",
    "330017": "COMMON",
    "330018": "COMMON",
    "330019": "COMMON",
    "330020": "COMMON",
    "331011": "UNCOMMON",
    "331021": "UNCOMMON",
    "331031": "UNCOMMON",
    "331041": "UNCOMMON",
    "331051": "UNCOMMON",
    "331061": "UNCOMMON",
    "331071": "UNCOMMON",
    "331081": "UNCOMMON",
    "331091": "UNCOMMON",
    "331101": "UNCOMMON",
    "331111": "UNCOMMON",
    "331121": "UNCOMMON",
    "331131": "UNCOMMON",
    "331141": "UNCOMMON",
    "331151": "UNCOMMON",
    "331161": "UNCOMMON",
    "331171": "UNCOMMON",
    "331181": "UNCOMMON",
    "331191": "UNCOMMON",
    "332011": "RARE",
    "332021": "RARE",
    "332031": "RARE",
    "332041": "RARE",
    "332051": "RARE",
    "332061": "RARE",
    "332071": "RARE",
    "332081": "RARE",
    "332091": "RARE",
    "332101": "RARE",
    "332111": "RARE",
    "332121": "RARE",
    "332131": "RARE",
    "332141": "RARE",
    "332151": "RARE",
    "332161": "RARE",
    "332171": "RARE",
    "332181": "RARE",
    "332191": "RARE",
    "333011": "LEGENDARY",
    "333021": "LEGENDARY",
    "333031": "LEGENDARY",
    "333041": "LEGENDARY",
    "333051": "LEGENDARY",
    "333061": "LEGENDARY",
    "333071": "LEGENDARY",
    "333081": "LEGENDARY",
    "333091": "LEGENDARY",
    "333101": "LEGENDARY",
    "333111": "LEGENDARY",
    "333121": "LEGENDARY",
    "333131": "LEGENDARY",
    "333141": "LEGENDARY",
    "333151": "LEGENDARY",
    "333161": "LEGENDARY",
    "333171": "LEGENDARY",
    "333181": "LEGENDARY",
    "333191": "LEGENDARY",
    "334011": "IMMORTAL",
    "334021": "IMMORTAL",
    "334031": "IMMORTAL",
    "334041": "IMMORTAL",
    "334051": "IMMORTAL",
    "334061": "IMMORTAL",
    "334071": "IMMORTAL",
    "334081": "IMMORTAL",
    "334091": "IMMORTAL",
    "334101": "IMMORTAL",
    "334111": "IMMORTAL",
    "334121": "IMMORTAL",
    "334131": "IMMORTAL",
    "334141": "IMMORTAL",
    "334151": "IMMORTAL",
    "334161": "IMMORTAL",
    "334171": "IMMORTAL",
    "334181": "IMMORTAL",
    "334191": "IMMORTAL",
    "335041": "ARCANA",
    "335051": "ARCANA",
    "335061": "ARCANA",
    "335071": "ARCANA",
    "335081": "ARCANA",
    "335091": "ARCANA",
    "335101": "ARCANA",
    "335111": "ARCANA",
    "335121": "ARCANA",
    "335131": "ARCANA",
    "335141": "ARCANA",
    "335151": "ARCANA",
    "335161": "ARCANA",
    "335171": "ARCANA",
    "335181": "ARCANA",
    "335191": "ARCANA",
    "336061": "BEYOND",
    "336071": "BEYOND",
    "336081": "BEYOND",
    "336091": "BEYOND",
    "336101": "BEYOND",
    "336111": "BEYOND",
    "336121": "BEYOND",
    "336131": "BEYOND",
    "336141": "BEYOND",
    "336151": "BEYOND",
    "336161": "BEYOND",
    "336171": "BEYOND",
    "336181": "BEYOND",
    "336191": "BEYOND",
    "337081": "CELESTIAL",
    "337091": "CELESTIAL",
    "337101": "CELESTIAL",
    "337111": "CELESTIAL",
    "337121": "CELESTIAL",
    "337131": "CELESTIAL",
    "337141": "CELESTIAL",
    "337151": "CELESTIAL",
    "337161": "CELESTIAL",
    "337171": "CELESTIAL",
    "337181": "CELESTIAL",
    "337191": "CELESTIAL",
    "338101": "DIVINE",
    "338111": "DIVINE",
    "338121": "DIVINE",
    "338131": "DIVINE",
    "338141": "DIVINE",
    "338151": "DIVINE",
    "338161": "DIVINE",
    "338171": "DIVINE",
    "338181": "DIVINE",
    "338191": "DIVINE",
    "339121": "COSMIC",
    "339131": "COSMIC",
    "339141": "COSMIC",
    "339151": "COSMIC",
    "339161": "COSMIC",
    "339171": "COSMIC",
    "339181": "COSMIC",
    "339191": "COSMIC",
    "340001": "COMMON",
    "340002": "COMMON",
    "340003": "COMMON",
    "340004": "COMMON",
    "340005": "COMMON",
    "340006": "COMMON",
    "340007": "COMMON",
    "340008": "COMMON",
    "340009": "COMMON",
    "340010": "COMMON",
    "340011": "COMMON",
    "340012": "COMMON",
    "340013": "COMMON",
    "340014": "COMMON",
    "340015": "COMMON",
    "340016": "COMMON",
    "340017": "COMMON",
    "340018": "COMMON",
    "340019": "COMMON",
    "340020": "COMMON",
    "341011": "UNCOMMON",
    "341021": "UNCOMMON",
    "341031": "UNCOMMON",
    "341041": "UNCOMMON",
    "341051": "UNCOMMON",
    "341061": "UNCOMMON",
    "341071": "UNCOMMON",
    "341081": "UNCOMMON",
    "341091": "UNCOMMON",
    "341101": "UNCOMMON",
    "341111": "UNCOMMON",
    "341121": "UNCOMMON",
    "341131": "UNCOMMON",
    "341141": "UNCOMMON",
    "341151": "UNCOMMON",
    "341161": "UNCOMMON",
    "341171": "UNCOMMON",
    "341181": "UNCOMMON",
    "341191": "UNCOMMON",
    "342011": "RARE",
    "342021": "RARE",
    "342031": "RARE",
    "342041": "RARE",
    "342051": "RARE",
    "342061": "RARE",
    "342071": "RARE",
    "342081": "RARE",
    "342091": "RARE",
    "342101": "RARE",
    "342111": "RARE",
    "342121": "RARE",
    "342131": "RARE",
    "342141": "RARE",
    "342151": "RARE",
    "342161": "RARE",
    "342171": "RARE",
    "342181": "RARE",
    "342191": "RARE",
    "343011": "LEGENDARY",
    "343021": "LEGENDARY",
    "343031": "LEGENDARY",
    "343041": "LEGENDARY",
    "343051": "LEGENDARY",
    "343061": "LEGENDARY",
    "343071": "LEGENDARY",
    "343081": "LEGENDARY",
    "343091": "LEGENDARY",
    "343101": "LEGENDARY",
    "343111": "LEGENDARY",
    "343121": "LEGENDARY",
    "343131": "LEGENDARY",
    "343141": "LEGENDARY",
    "343151": "LEGENDARY",
    "343161": "LEGENDARY",
    "343171": "LEGENDARY",
    "343181": "LEGENDARY",
    "343191": "LEGENDARY",
    "344011": "IMMORTAL",
    "344021": "IMMORTAL",
    "344031": "IMMORTAL",
    "344041": "IMMORTAL",
    "344051": "IMMORTAL",
    "344061": "IMMORTAL",
    "344071": "IMMORTAL",
    "344081": "IMMORTAL",
    "344091": "IMMORTAL",
    "344101": "IMMORTAL",
    "344111": "IMMORTAL",
    "344121": "IMMORTAL",
    "344131": "IMMORTAL",
    "344141": "IMMORTAL",
    "344151": "IMMORTAL",
    "344161": "IMMORTAL",
    "344171": "IMMORTAL",
    "344181": "IMMORTAL",
    "344191": "IMMORTAL",
    "345041": "ARCANA",
    "345051": "ARCANA",
    "345061": "ARCANA",
    "345071": "ARCANA",
    "345081": "ARCANA",
    "345091": "ARCANA",
    "345101": "ARCANA",
    "345111": "ARCANA",
    "345121": "ARCANA",
    "345131": "ARCANA",
    "345141": "ARCANA",
    "345151": "ARCANA",
    "345161": "ARCANA",
    "345171": "ARCANA",
    "345181": "ARCANA",
    "345191": "ARCANA",
    "346061": "BEYOND",
    "346071": "BEYOND",
    "346081": "BEYOND",
    "346091": "BEYOND",
    "346101": "BEYOND",
    "346111": "BEYOND",
    "346121": "BEYOND",
    "346131": "BEYOND",
    "346141": "BEYOND",
    "346151": "BEYOND",
    "346161": "BEYOND",
    "346171": "BEYOND",
    "346181": "BEYOND",
    "346191": "BEYOND",
    "347081": "CELESTIAL",
    "347091": "CELESTIAL",
    "347101": "CELESTIAL",
    "347111": "CELESTIAL",
    "347121": "CELESTIAL",
    "347131": "CELESTIAL",
    "347141": "CELESTIAL",
    "347151": "CELESTIAL",
    "347161": "CELESTIAL",
    "347171": "CELESTIAL",
    "347181": "CELESTIAL",
    "347191": "CELESTIAL",
    "348101": "DIVINE",
    "348111": "DIVINE",
    "348121": "DIVINE",
    "348131": "DIVINE",
    "348141": "DIVINE",
    "348151": "DIVINE",
    "348161": "DIVINE",
    "348171": "DIVINE",
    "348181": "DIVINE",
    "348191": "DIVINE",
    "349121": "COSMIC",
    "349131": "COSMIC",
    "349141": "COSMIC",
    "349151": "COSMIC",
    "349161": "COSMIC",
    "349171": "COSMIC",
    "349181": "COSMIC",
    "349191": "COSMIC",
    "350001": "COMMON",
    "350002": "COMMON",
    "350003": "COMMON",
    "350004": "COMMON",
    "350005": "COMMON",
    "350006": "COMMON",
    "350007": "COMMON",
    "350008": "COMMON",
    "350009": "COMMON",
    "350010": "COMMON",
    "350011": "COMMON",
    "350012": "COMMON",
    "350013": "COMMON",
    "350014": "COMMON",
    "350015": "COMMON",
    "350016": "COMMON",
    "350017": "COMMON",
    "350018": "COMMON",
    "350019": "COMMON",
    "350020": "COMMON",
    "351011": "UNCOMMON",
    "351021": "UNCOMMON",
    "351031": "UNCOMMON",
    "351041": "UNCOMMON",
    "351051": "UNCOMMON",
    "351061": "UNCOMMON",
    "351071": "UNCOMMON",
    "351081": "UNCOMMON",
    "351091": "UNCOMMON",
    "351101": "UNCOMMON",
    "351111": "UNCOMMON",
    "351121": "UNCOMMON",
    "351131": "UNCOMMON",
    "351141": "UNCOMMON",
    "351151": "UNCOMMON",
    "351161": "UNCOMMON",
    "351171": "UNCOMMON",
    "351181": "UNCOMMON",
    "351191": "UNCOMMON",
    "352011": "RARE",
    "352021": "RARE",
    "352031": "RARE",
    "352041": "RARE",
    "352051": "RARE",
    "352061": "RARE",
    "352071": "RARE",
    "352081": "RARE",
    "352091": "RARE",
    "352101": "RARE",
    "352111": "RARE",
    "352121": "RARE",
    "352131": "RARE",
    "352141": "RARE",
    "352151": "RARE",
    "352161": "RARE",
    "352171": "RARE",
    "352181": "RARE",
    "352191": "RARE",
    "353011": "LEGENDARY",
    "353021": "LEGENDARY",
    "353031": "LEGENDARY",
    "353041": "LEGENDARY",
    "353051": "LEGENDARY",
    "353061": "LEGENDARY",
    "353071": "LEGENDARY",
    "353081": "LEGENDARY",
    "353091": "LEGENDARY",
    "353101": "LEGENDARY",
    "353111": "LEGENDARY",
    "353121": "LEGENDARY",
    "353131": "LEGENDARY",
    "353141": "LEGENDARY",
    "353151": "LEGENDARY",
    "353161": "LEGENDARY",
    "353171": "LEGENDARY",
    "353181": "LEGENDARY",
    "353191": "LEGENDARY",
    "354011": "IMMORTAL",
    "354021": "IMMORTAL",
    "354031": "IMMORTAL",
    "354041": "IMMORTAL",
    "354051": "IMMORTAL",
    "354061": "IMMORTAL",
    "354071": "IMMORTAL",
    "354081": "IMMORTAL",
    "354091": "IMMORTAL",
    "354101": "IMMORTAL",
    "354111": "IMMORTAL",
    "354121": "IMMORTAL",
    "354131": "IMMORTAL",
    "354141": "IMMORTAL",
    "354151": "IMMORTAL",
    "354161": "IMMORTAL",
    "354171": "IMMORTAL",
    "354181": "IMMORTAL",
    "354191": "IMMORTAL",
    "355041": "ARCANA",
    "355051": "ARCANA",
    "355061": "ARCANA",
    "355071": "ARCANA",
    "355081": "ARCANA",
    "355091": "ARCANA",
    "355101": "ARCANA",
    "355111": "ARCANA",
    "355121": "ARCANA",
    "355131": "ARCANA",
    "355141": "ARCANA",
    "355151": "ARCANA",
    "355161": "ARCANA",
    "355171": "ARCANA",
    "355181": "ARCANA",
    "355191": "ARCANA",
    "356061": "BEYOND",
    "356071": "BEYOND",
    "356081": "BEYOND",
    "356091": "BEYOND",
    "356101": "BEYOND",
    "356111": "BEYOND",
    "356121": "BEYOND",
    "356131": "BEYOND",
    "356141": "BEYOND",
    "356151": "BEYOND",
    "356161": "BEYOND",
    "356171": "BEYOND",
    "356181": "BEYOND",
    "356191": "BEYOND",
    "357081": "CELESTIAL",
    "357091": "CELESTIAL",
    "357101": "CELESTIAL",
    "357111": "CELESTIAL",
    "357121": "CELESTIAL",
    "357131": "CELESTIAL",
    "357141": "CELESTIAL",
    "357151": "CELESTIAL",
    "357161": "CELESTIAL",
    "357171": "CELESTIAL",
    "357181": "CELESTIAL",
    "357191": "CELESTIAL",
    "358101": "DIVINE",
    "358111": "DIVINE",
    "358121": "DIVINE",
    "358131": "DIVINE",
    "358141": "DIVINE",
    "358151": "DIVINE",
    "358161": "DIVINE",
    "358171": "DIVINE",
    "358181": "DIVINE",
    "358191": "DIVINE",
    "359121": "COSMIC",
    "359131": "COSMIC",
    "359141": "COSMIC",
    "359151": "COSMIC",
    "359161": "COSMIC",
    "359171": "COSMIC",
    "359181": "COSMIC",
    "359191": "COSMIC",
    "400001": "COMMON",
    "400002": "COMMON",
    "400003": "COMMON",
    "400004": "COMMON",
    "400005": "COMMON",
    "400006": "COMMON",
    "400007": "COMMON",
    "400008": "COMMON",
    "400009": "COMMON",
    "400010": "COMMON",
    "400011": "COMMON",
    "400012": "COMMON",
    "400013": "COMMON",
    "400014": "COMMON",
    "400015": "COMMON",
    "400016": "COMMON",
    "400017": "COMMON",
    "400018": "COMMON",
    "400019": "COMMON",
    "400020": "COMMON",
    "401011": "UNCOMMON",
    "401021": "UNCOMMON",
    "401031": "UNCOMMON",
    "401041": "UNCOMMON",
    "401051": "UNCOMMON",
    "401061": "UNCOMMON",
    "401071": "UNCOMMON",
    "401081": "UNCOMMON",
    "401091": "UNCOMMON",
    "401101": "UNCOMMON",
    "401111": "UNCOMMON",
    "401121": "UNCOMMON",
    "401131": "UNCOMMON",
    "401141": "UNCOMMON",
    "401151": "UNCOMMON",
    "401161": "UNCOMMON",
    "401171": "UNCOMMON",
    "401181": "UNCOMMON",
    "401191": "UNCOMMON",
    "402011": "RARE",
    "402021": "RARE",
    "402031": "RARE",
    "402041": "RARE",
    "402051": "RARE",
    "402061": "RARE",
    "402071": "RARE",
    "402081": "RARE",
    "402091": "RARE",
    "402101": "RARE",
    "402111": "RARE",
    "402121": "RARE",
    "402131": "RARE",
    "402141": "RARE",
    "402151": "RARE",
    "402161": "RARE",
    "402171": "RARE",
    "402181": "RARE",
    "402191": "RARE",
    "403011": "LEGENDARY",
    "403021": "LEGENDARY",
    "403031": "LEGENDARY",
    "403041": "LEGENDARY",
    "403051": "LEGENDARY",
    "403061": "LEGENDARY",
    "403071": "LEGENDARY",
    "403081": "LEGENDARY",
    "403091": "LEGENDARY",
    "403101": "LEGENDARY",
    "403111": "LEGENDARY",
    "403121": "LEGENDARY",
    "403131": "LEGENDARY",
    "403141": "LEGENDARY",
    "403151": "LEGENDARY",
    "403161": "LEGENDARY",
    "403171": "LEGENDARY",
    "403181": "LEGENDARY",
    "403191": "LEGENDARY",
    "404011": "IMMORTAL",
    "404021": "IMMORTAL",
    "404031": "IMMORTAL",
    "404041": "IMMORTAL",
    "404051": "IMMORTAL",
    "404061": "IMMORTAL",
    "404071": "IMMORTAL",
    "404081": "IMMORTAL",
    "404091": "IMMORTAL",
    "404101": "IMMORTAL",
    "404111": "IMMORTAL",
    "404121": "IMMORTAL",
    "404131": "IMMORTAL",
    "404141": "IMMORTAL",
    "404151": "IMMORTAL",
    "404161": "IMMORTAL",
    "404171": "IMMORTAL",
    "404181": "IMMORTAL",
    "404191": "IMMORTAL",
    "405041": "ARCANA",
    "405051": "ARCANA",
    "405061": "ARCANA",
    "405071": "ARCANA",
    "405081": "ARCANA",
    "405091": "ARCANA",
    "405101": "ARCANA",
    "405111": "ARCANA",
    "405121": "ARCANA",
    "405131": "ARCANA",
    "405141": "ARCANA",
    "405151": "ARCANA",
    "405161": "ARCANA",
    "405171": "ARCANA",
    "405181": "ARCANA",
    "405191": "ARCANA",
    "406061": "BEYOND",
    "406071": "BEYOND",
    "406081": "BEYOND",
    "406091": "BEYOND",
    "406101": "BEYOND",
    "406111": "BEYOND",
    "406121": "BEYOND",
    "406131": "BEYOND",
    "406141": "BEYOND",
    "406151": "BEYOND",
    "406161": "BEYOND",
    "406171": "BEYOND",
    "406181": "BEYOND",
    "406191": "BEYOND",
    "407081": "CELESTIAL",
    "407091": "CELESTIAL",
    "407101": "CELESTIAL",
    "407111": "CELESTIAL",
    "407121": "CELESTIAL",
    "407131": "CELESTIAL",
    "407141": "CELESTIAL",
    "407151": "CELESTIAL",
    "407161": "CELESTIAL",
    "407171": "CELESTIAL",
    "407181": "CELESTIAL",
    "407191": "CELESTIAL",
    "408101": "DIVINE",
    "408111": "DIVINE",
    "408121": "DIVINE",
    "408131": "DIVINE",
    "408141": "DIVINE",
    "408151": "DIVINE",
    "408161": "DIVINE",
    "408171": "DIVINE",
    "408181": "DIVINE",
    "408191": "DIVINE",
    "409121": "COSMIC",
    "409131": "COSMIC",
    "409141": "COSMIC",
    "409151": "COSMIC",
    "409161": "COSMIC",
    "409171": "COSMIC",
    "409181": "COSMIC",
    "409191": "COSMIC",
    "410001": "COMMON",
    "410002": "COMMON",
    "410003": "COMMON",
    "410004": "COMMON",
    "410005": "COMMON",
    "410006": "COMMON",
    "410007": "COMMON",
    "410008": "COMMON",
    "410009": "COMMON",
    "410010": "COMMON",
    "410011": "COMMON",
    "410012": "COMMON",
    "410013": "COMMON",
    "410014": "COMMON",
    "410015": "COMMON",
    "410016": "COMMON",
    "410017": "COMMON",
    "410018": "COMMON",
    "410019": "COMMON",
    "410020": "COMMON",
    "411011": "UNCOMMON",
    "411021": "UNCOMMON",
    "411031": "UNCOMMON",
    "411041": "UNCOMMON",
    "411051": "UNCOMMON",
    "411061": "UNCOMMON",
    "411071": "UNCOMMON",
    "411081": "UNCOMMON",
    "411091": "UNCOMMON",
    "411101": "UNCOMMON",
    "411111": "UNCOMMON",
    "411121": "UNCOMMON",
    "411131": "UNCOMMON",
    "411141": "UNCOMMON",
    "411151": "UNCOMMON",
    "411161": "UNCOMMON",
    "411171": "UNCOMMON",
    "411181": "UNCOMMON",
    "411191": "UNCOMMON",
    "412011": "RARE",
    "412021": "RARE",
    "412031": "RARE",
    "412041": "RARE",
    "412051": "RARE",
    "412061": "RARE",
    "412071": "RARE",
    "412081": "RARE",
    "412091": "RARE",
    "412101": "RARE",
    "412111": "RARE",
    "412121": "RARE",
    "412131": "RARE",
    "412141": "RARE",
    "412151": "RARE",
    "412161": "RARE",
    "412171": "RARE",
    "412181": "RARE",
    "412191": "RARE",
    "413011": "LEGENDARY",
    "413021": "LEGENDARY",
    "413031": "LEGENDARY",
    "413041": "LEGENDARY",
    "413051": "LEGENDARY",
    "413061": "LEGENDARY",
    "413071": "LEGENDARY",
    "413081": "LEGENDARY",
    "413091": "LEGENDARY",
    "413101": "LEGENDARY",
    "413111": "LEGENDARY",
    "413121": "LEGENDARY",
    "413131": "LEGENDARY",
    "413141": "LEGENDARY",
    "413151": "LEGENDARY",
    "413161": "LEGENDARY",
    "413171": "LEGENDARY",
    "413181": "LEGENDARY",
    "413191": "LEGENDARY",
    "414011": "IMMORTAL",
    "414021": "IMMORTAL",
    "414031": "IMMORTAL",
    "414041": "IMMORTAL",
    "414051": "IMMORTAL",
    "414061": "IMMORTAL",
    "414071": "IMMORTAL",
    "414081": "IMMORTAL",
    "414091": "IMMORTAL",
    "414101": "IMMORTAL",
    "414111": "IMMORTAL",
    "414121": "IMMORTAL",
    "414131": "IMMORTAL",
    "414141": "IMMORTAL",
    "414151": "IMMORTAL",
    "414161": "IMMORTAL",
    "414171": "IMMORTAL",
    "414181": "IMMORTAL",
    "414191": "IMMORTAL",
    "415041": "ARCANA",
    "415051": "ARCANA",
    "415061": "ARCANA",
    "415071": "ARCANA",
    "415081": "ARCANA",
    "415091": "ARCANA",
    "415101": "ARCANA",
    "415111": "ARCANA",
    "415121": "ARCANA",
    "415131": "ARCANA",
    "415141": "ARCANA",
    "415151": "ARCANA",
    "415161": "ARCANA",
    "415171": "ARCANA",
    "415181": "ARCANA",
    "415191": "ARCANA",
    "416061": "BEYOND",
    "416071": "BEYOND",
    "416081": "BEYOND",
    "416091": "BEYOND",
    "416101": "BEYOND",
    "416111": "BEYOND",
    "416121": "BEYOND",
    "416131": "BEYOND",
    "416141": "BEYOND",
    "416151": "BEYOND",
    "416161": "BEYOND",
    "416171": "BEYOND",
    "416181": "BEYOND",
    "416191": "BEYOND",
    "417081": "CELESTIAL",
    "417091": "CELESTIAL",
    "417101": "CELESTIAL",
    "417111": "CELESTIAL",
    "417121": "CELESTIAL",
    "417131": "CELESTIAL",
    "417141": "CELESTIAL",
    "417151": "CELESTIAL",
    "417161": "CELESTIAL",
    "417171": "CELESTIAL",
    "417181": "CELESTIAL",
    "417191": "CELESTIAL",
    "418101": "DIVINE",
    "418111": "DIVINE",
    "418121": "DIVINE",
    "418131": "DIVINE",
    "418141": "DIVINE",
    "418151": "DIVINE",
    "418161": "DIVINE",
    "418171": "DIVINE",
    "418181": "DIVINE",
    "418191": "DIVINE",
    "419121": "COSMIC",
    "419131": "COSMIC",
    "419141": "COSMIC",
    "419151": "COSMIC",
    "419161": "COSMIC",
    "419171": "COSMIC",
    "419181": "COSMIC",
    "419191": "COSMIC",
    "420001": "COMMON",
    "420002": "COMMON",
    "420003": "COMMON",
    "420004": "COMMON",
    "420005": "COMMON",
    "420006": "COMMON",
    "420007": "COMMON",
    "420008": "COMMON",
    "420009": "COMMON",
    "420010": "COMMON",
    "420011": "COMMON",
    "420012": "COMMON",
    "420013": "COMMON",
    "420014": "COMMON",
    "420015": "COMMON",
    "420016": "COMMON",
    "420017": "COMMON",
    "420018": "COMMON",
    "420019": "COMMON",
    "420020": "COMMON",
    "421011": "UNCOMMON",
    "421021": "UNCOMMON",
    "421031": "UNCOMMON",
    "421041": "UNCOMMON",
    "421051": "UNCOMMON",
    "421061": "UNCOMMON",
    "421071": "UNCOMMON",
    "421081": "UNCOMMON",
    "421091": "UNCOMMON",
    "421101": "UNCOMMON",
    "421111": "UNCOMMON",
    "421121": "UNCOMMON",
    "421131": "UNCOMMON",
    "421141": "UNCOMMON",
    "421151": "UNCOMMON",
    "421161": "UNCOMMON",
    "421171": "UNCOMMON",
    "421181": "UNCOMMON",
    "421191": "UNCOMMON",
    "422011": "RARE",
    "422021": "RARE",
    "422031": "RARE",
    "422041": "RARE",
    "422051": "RARE",
    "422061": "RARE",
    "422071": "RARE",
    "422081": "RARE",
    "422091": "RARE",
    "422101": "RARE",
    "422111": "RARE",
    "422121": "RARE",
    "422131": "RARE",
    "422141": "RARE",
    "422151": "RARE",
    "422161": "RARE",
    "422171": "RARE",
    "422181": "RARE",
    "422191": "RARE",
    "423011": "LEGENDARY",
    "423021": "LEGENDARY",
    "423031": "LEGENDARY",
    "423041": "LEGENDARY",
    "423051": "LEGENDARY",
    "423061": "LEGENDARY",
    "423071": "LEGENDARY",
    "423081": "LEGENDARY",
    "423091": "LEGENDARY",
    "423101": "LEGENDARY",
    "423111": "LEGENDARY",
    "423121": "LEGENDARY",
    "423131": "LEGENDARY",
    "423141": "LEGENDARY",
    "423151": "LEGENDARY",
    "423161": "LEGENDARY",
    "423171": "LEGENDARY",
    "423181": "LEGENDARY",
    "423191": "LEGENDARY",
    "424011": "IMMORTAL",
    "424021": "IMMORTAL",
    "424031": "IMMORTAL",
    "424041": "IMMORTAL",
    "424051": "IMMORTAL",
    "424061": "IMMORTAL",
    "424071": "IMMORTAL",
    "424081": "IMMORTAL",
    "424091": "IMMORTAL",
    "424101": "IMMORTAL",
    "424111": "IMMORTAL",
    "424121": "IMMORTAL",
    "424131": "IMMORTAL",
    "424141": "IMMORTAL",
    "424151": "IMMORTAL",
    "424161": "IMMORTAL",
    "424171": "IMMORTAL",
    "424181": "IMMORTAL",
    "424191": "IMMORTAL",
    "425041": "ARCANA",
    "425051": "ARCANA",
    "425061": "ARCANA",
    "425071": "ARCANA",
    "425081": "ARCANA",
    "425091": "ARCANA",
    "425101": "ARCANA",
    "425111": "ARCANA",
    "425121": "ARCANA",
    "425131": "ARCANA",
    "425141": "ARCANA",
    "425151": "ARCANA",
    "425161": "ARCANA",
    "425171": "ARCANA",
    "425181": "ARCANA",
    "425191": "ARCANA",
    "426061": "BEYOND",
    "426071": "BEYOND",
    "426081": "BEYOND",
    "426091": "BEYOND",
    "426101": "BEYOND",
    "426111": "BEYOND",
    "426121": "BEYOND",
    "426131": "BEYOND",
    "426141": "BEYOND",
    "426151": "BEYOND",
    "426161": "BEYOND",
    "426171": "BEYOND",
    "426181": "BEYOND",
    "426191": "BEYOND",
    "427081": "CELESTIAL",
    "427091": "CELESTIAL",
    "427101": "CELESTIAL",
    "427111": "CELESTIAL",
    "427121": "CELESTIAL",
    "427131": "CELESTIAL",
    "427141": "CELESTIAL",
    "427151": "CELESTIAL",
    "427161": "CELESTIAL",
    "427171": "CELESTIAL",
    "427181": "CELESTIAL",
    "427191": "CELESTIAL",
    "428101": "DIVINE",
    "428111": "DIVINE",
    "428121": "DIVINE",
    "428131": "DIVINE",
    "428141": "DIVINE",
    "428151": "DIVINE",
    "428161": "DIVINE",
    "428171": "DIVINE",
    "428181": "DIVINE",
    "428191": "DIVINE",
    "429121": "COSMIC",
    "429131": "COSMIC",
    "429141": "COSMIC",
    "429151": "COSMIC",
    "429161": "COSMIC",
    "429171": "COSMIC",
    "429181": "COSMIC",
    "429191": "COSMIC",
    "430001": "COMMON",
    "430002": "COMMON",
    "430003": "COMMON",
    "430004": "COMMON",
    "430005": "COMMON",
    "430006": "COMMON",
    "430007": "COMMON",
    "430008": "COMMON",
    "430009": "COMMON",
    "430010": "COMMON",
    "430011": "COMMON",
    "430012": "COMMON",
    "430013": "COMMON",
    "430014": "COMMON",
    "430015": "COMMON",
    "430016": "COMMON",
    "430017": "COMMON",
    "430018": "COMMON",
    "430019": "COMMON",
    "430020": "COMMON",
    "431011": "UNCOMMON",
    "431021": "UNCOMMON",
    "431031": "UNCOMMON",
    "431041": "UNCOMMON",
    "431051": "UNCOMMON",
    "431061": "UNCOMMON",
    "431071": "UNCOMMON",
    "431081": "UNCOMMON",
    "431091": "UNCOMMON",
    "431101": "UNCOMMON",
    "431111": "UNCOMMON",
    "431121": "UNCOMMON",
    "431131": "UNCOMMON",
    "431141": "UNCOMMON",
    "431151": "UNCOMMON",
    "431161": "UNCOMMON",
    "431171": "UNCOMMON",
    "431181": "UNCOMMON",
    "431191": "UNCOMMON",
    "432011": "RARE",
    "432021": "RARE",
    "432031": "RARE",
    "432041": "RARE",
    "432051": "RARE",
    "432061": "RARE",
    "432071": "RARE",
    "432081": "RARE",
    "432091": "RARE",
    "432101": "RARE",
    "432111": "RARE",
    "432121": "RARE",
    "432131": "RARE",
    "432141": "RARE",
    "432151": "RARE",
    "432161": "RARE",
    "432171": "RARE",
    "432181": "RARE",
    "432191": "RARE",
    "433011": "LEGENDARY",
    "433021": "LEGENDARY",
    "433031": "LEGENDARY",
    "433041": "LEGENDARY",
    "433051": "LEGENDARY",
    "433061": "LEGENDARY",
    "433071": "LEGENDARY",
    "433081": "LEGENDARY",
    "433091": "LEGENDARY",
    "433101": "LEGENDARY",
    "433111": "LEGENDARY",
    "433121": "LEGENDARY",
    "433131": "LEGENDARY",
    "433141": "LEGENDARY",
    "433151": "LEGENDARY",
    "433161": "LEGENDARY",
    "433171": "LEGENDARY",
    "433181": "LEGENDARY",
    "433191": "LEGENDARY",
    "434011": "IMMORTAL",
    "434021": "IMMORTAL",
    "434031": "IMMORTAL",
    "434041": "IMMORTAL",
    "434051": "IMMORTAL",
    "434061": "IMMORTAL",
    "434071": "IMMORTAL",
    "434081": "IMMORTAL",
    "434091": "IMMORTAL",
    "434101": "IMMORTAL",
    "434111": "IMMORTAL",
    "434121": "IMMORTAL",
    "434131": "IMMORTAL",
    "434141": "IMMORTAL",
    "434151": "IMMORTAL",
    "434161": "IMMORTAL",
    "434171": "IMMORTAL",
    "434181": "IMMORTAL",
    "434191": "IMMORTAL",
    "435041": "ARCANA",
    "435051": "ARCANA",
    "435061": "ARCANA",
    "435071": "ARCANA",
    "435081": "ARCANA",
    "435091": "ARCANA",
    "435101": "ARCANA",
    "435111": "ARCANA",
    "435121": "ARCANA",
    "435131": "ARCANA",
    "435141": "ARCANA",
    "435151": "ARCANA",
    "435161": "ARCANA",
    "435171": "ARCANA",
    "435181": "ARCANA",
    "435191": "ARCANA",
    "436061": "BEYOND",
    "436071": "BEYOND",
    "436081": "BEYOND",
    "436091": "BEYOND",
    "436101": "BEYOND",
    "436111": "BEYOND",
    "436121": "BEYOND",
    "436131": "BEYOND",
    "436141": "BEYOND",
    "436151": "BEYOND",
    "436161": "BEYOND",
    "436171": "BEYOND",
    "436181": "BEYOND",
    "436191": "BEYOND",
    "437081": "CELESTIAL",
    "437091": "CELESTIAL",
    "437101": "CELESTIAL",
    "437111": "CELESTIAL",
    "437121": "CELESTIAL",
    "437131": "CELESTIAL",
    "437141": "CELESTIAL",
    "437151": "CELESTIAL",
    "437161": "CELESTIAL",
    "437171": "CELESTIAL",
    "437181": "CELESTIAL",
    "437191": "CELESTIAL",
    "438101": "DIVINE",
    "438111": "DIVINE",
    "438121": "DIVINE",
    "438131": "DIVINE",
    "438141": "DIVINE",
    "438151": "DIVINE",
    "438161": "DIVINE",
    "438171": "DIVINE",
    "438181": "DIVINE",
    "438191": "DIVINE",
    "439121": "COSMIC",
    "439131": "COSMIC",
    "439141": "COSMIC",
    "439151": "COSMIC",
    "439161": "COSMIC",
    "439171": "COSMIC",
    "439181": "COSMIC",
    "439191": "COSMIC",
    "440001": "COMMON",
    "440002": "COMMON",
    "440003": "COMMON",
    "440004": "COMMON",
    "440005": "COMMON",
    "440006": "COMMON",
    "440007": "COMMON",
    "440008": "COMMON",
    "440009": "COMMON",
    "440010": "COMMON",
    "440011": "COMMON",
    "440012": "COMMON",
    "440013": "COMMON",
    "440014": "COMMON",
    "440015": "COMMON",
    "440016": "COMMON",
    "440017": "COMMON",
    "440018": "COMMON",
    "440019": "COMMON",
    "440020": "COMMON",
    "441011": "UNCOMMON",
    "441021": "UNCOMMON",
    "441031": "UNCOMMON",
    "441041": "UNCOMMON",
    "441051": "UNCOMMON",
    "441061": "UNCOMMON",
    "441071": "UNCOMMON",
    "441081": "UNCOMMON",
    "441091": "UNCOMMON",
    "441101": "UNCOMMON",
    "441111": "UNCOMMON",
    "441121": "UNCOMMON",
    "441131": "UNCOMMON",
    "441141": "UNCOMMON",
    "441151": "UNCOMMON",
    "441161": "UNCOMMON",
    "441171": "UNCOMMON",
    "441181": "UNCOMMON",
    "441191": "UNCOMMON",
    "442011": "RARE",
    "442021": "RARE",
    "442031": "RARE",
    "442041": "RARE",
    "442051": "RARE",
    "442061": "RARE",
    "442071": "RARE",
    "442081": "RARE",
    "442091": "RARE",
    "442101": "RARE",
    "442111": "RARE",
    "442121": "RARE",
    "442131": "RARE",
    "442141": "RARE",
    "442151": "RARE",
    "442161": "RARE",
    "442171": "RARE",
    "442181": "RARE",
    "442191": "RARE",
    "443011": "LEGENDARY",
    "443021": "LEGENDARY",
    "443031": "LEGENDARY",
    "443041": "LEGENDARY",
    "443051": "LEGENDARY",
    "443061": "LEGENDARY",
    "443071": "LEGENDARY",
    "443081": "LEGENDARY",
    "443091": "LEGENDARY",
    "443101": "LEGENDARY",
    "443111": "LEGENDARY",
    "443121": "LEGENDARY",
    "443131": "LEGENDARY",
    "443141": "LEGENDARY",
    "443151": "LEGENDARY",
    "443161": "LEGENDARY",
    "443171": "LEGENDARY",
    "443181": "LEGENDARY",
    "443191": "LEGENDARY",
    "444011": "IMMORTAL",
    "444021": "IMMORTAL",
    "444031": "IMMORTAL",
    "444041": "IMMORTAL",
    "444051": "IMMORTAL",
    "444061": "IMMORTAL",
    "444071": "IMMORTAL",
    "444081": "IMMORTAL",
    "444091": "IMMORTAL",
    "444101": "IMMORTAL",
    "444111": "IMMORTAL",
    "444121": "IMMORTAL",
    "444131": "IMMORTAL",
    "444141": "IMMORTAL",
    "444151": "IMMORTAL",
    "444161": "IMMORTAL",
    "444171": "IMMORTAL",
    "444181": "IMMORTAL",
    "444191": "IMMORTAL",
    "445041": "ARCANA",
    "445051": "ARCANA",
    "445061": "ARCANA",
    "445071": "ARCANA",
    "445081": "ARCANA",
    "445091": "ARCANA",
    "445101": "ARCANA",
    "445111": "ARCANA",
    "445121": "ARCANA",
    "445131": "ARCANA",
    "445141": "ARCANA",
    "445151": "ARCANA",
    "445161": "ARCANA",
    "445171": "ARCANA",
    "445181": "ARCANA",
    "445191": "ARCANA",
    "446061": "BEYOND",
    "446071": "BEYOND",
    "446081": "BEYOND",
    "446091": "BEYOND",
    "446101": "BEYOND",
    "446111": "BEYOND",
    "446121": "BEYOND",
    "446131": "BEYOND",
    "446141": "BEYOND",
    "446151": "BEYOND",
    "446161": "BEYOND",
    "446171": "BEYOND",
    "446181": "BEYOND",
    "446191": "BEYOND",
    "447081": "CELESTIAL",
    "447091": "CELESTIAL",
    "447101": "CELESTIAL",
    "447111": "CELESTIAL",
    "447121": "CELESTIAL",
    "447131": "CELESTIAL",
    "447141": "CELESTIAL",
    "447151": "CELESTIAL",
    "447161": "CELESTIAL",
    "447171": "CELESTIAL",
    "447181": "CELESTIAL",
    "447191": "CELESTIAL",
    "448101": "DIVINE",
    "448111": "DIVINE",
    "448121": "DIVINE",
    "448131": "DIVINE",
    "448141": "DIVINE",
    "448151": "DIVINE",
    "448161": "DIVINE",
    "448171": "DIVINE",
    "448181": "DIVINE",
    "448191": "DIVINE",
    "449121": "COSMIC",
    "449131": "COSMIC",
    "449141": "COSMIC",
    "449151": "COSMIC",
    "449161": "COSMIC",
    "449171": "COSMIC",
    "449181": "COSMIC",
    "449191": "COSMIC",
    "450001": "COMMON",
    "450002": "COMMON",
    "450003": "COMMON",
    "450004": "COMMON",
    "450005": "COMMON",
    "450006": "COMMON",
    "450007": "COMMON",
    "450008": "COMMON",
    "450009": "COMMON",
    "450010": "COMMON",
    "450011": "COMMON",
    "450012": "COMMON",
    "450013": "COMMON",
    "450014": "COMMON",
    "450015": "COMMON",
    "450016": "COMMON",
    "450017": "COMMON",
    "450018": "COMMON",
    "450019": "COMMON",
    "450020": "COMMON",
    "451011": "UNCOMMON",
    "451021": "UNCOMMON",
    "451031": "UNCOMMON",
    "451041": "UNCOMMON",
    "451051": "UNCOMMON",
    "451061": "UNCOMMON",
    "451071": "UNCOMMON",
    "451081": "UNCOMMON",
    "451091": "UNCOMMON",
    "451101": "UNCOMMON",
    "451111": "UNCOMMON",
    "451121": "UNCOMMON",
    "451131": "UNCOMMON",
    "451141": "UNCOMMON",
    "451151": "UNCOMMON",
    "451161": "UNCOMMON",
    "451171": "UNCOMMON",
    "451181": "UNCOMMON",
    "451191": "UNCOMMON",
    "452011": "RARE",
    "452021": "RARE",
    "452031": "RARE",
    "452041": "RARE",
    "452051": "RARE",
    "452061": "RARE",
    "452071": "RARE",
    "452081": "RARE",
    "452091": "RARE",
    "452101": "RARE",
    "452111": "RARE",
    "452121": "RARE",
    "452131": "RARE",
    "452141": "RARE",
    "452151": "RARE",
    "452161": "RARE",
    "452171": "RARE",
    "452181": "RARE",
    "452191": "RARE",
    "453011": "LEGENDARY",
    "453021": "LEGENDARY",
    "453031": "LEGENDARY",
    "453041": "LEGENDARY",
    "453051": "LEGENDARY",
    "453061": "LEGENDARY",
    "453071": "LEGENDARY",
    "453081": "LEGENDARY",
    "453091": "LEGENDARY",
    "453101": "LEGENDARY",
    "453111": "LEGENDARY",
    "453121": "LEGENDARY",
    "453131": "LEGENDARY",
    "453141": "LEGENDARY",
    "453151": "LEGENDARY",
    "453161": "LEGENDARY",
    "453171": "LEGENDARY",
    "453181": "LEGENDARY",
    "453191": "LEGENDARY",
    "454011": "IMMORTAL",
    "454021": "IMMORTAL",
    "454031": "IMMORTAL",
    "454041": "IMMORTAL",
    "454051": "IMMORTAL",
    "454061": "IMMORTAL",
    "454071": "IMMORTAL",
    "454081": "IMMORTAL",
    "454091": "IMMORTAL",
    "454101": "IMMORTAL",
    "454111": "IMMORTAL",
    "454121": "IMMORTAL",
    "454131": "IMMORTAL",
    "454141": "IMMORTAL",
    "454151": "IMMORTAL",
    "454161": "IMMORTAL",
    "454171": "IMMORTAL",
    "454181": "IMMORTAL",
    "454191": "IMMORTAL",
    "455041": "ARCANA",
    "455051": "ARCANA",
    "455061": "ARCANA",
    "455071": "ARCANA",
    "455081": "ARCANA",
    "455091": "ARCANA",
    "455101": "ARCANA",
    "455111": "ARCANA",
    "455121": "ARCANA",
    "455131": "ARCANA",
    "455141": "ARCANA",
    "455151": "ARCANA",
    "455161": "ARCANA",
    "455171": "ARCANA",
    "455181": "ARCANA",
    "455191": "ARCANA",
    "456061": "BEYOND",
    "456071": "BEYOND",
    "456081": "BEYOND",
    "456091": "BEYOND",
    "456101": "BEYOND",
    "456111": "BEYOND",
    "456121": "BEYOND",
    "456131": "BEYOND",
    "456141": "BEYOND",
    "456151": "BEYOND",
    "456161": "BEYOND",
    "456171": "BEYOND",
    "456181": "BEYOND",
    "456191": "BEYOND",
    "457081": "CELESTIAL",
    "457091": "CELESTIAL",
    "457101": "CELESTIAL",
    "457111": "CELESTIAL",
    "457121": "CELESTIAL",
    "457131": "CELESTIAL",
    "457141": "CELESTIAL",
    "457151": "CELESTIAL",
    "457161": "CELESTIAL",
    "457171": "CELESTIAL",
    "457181": "CELESTIAL",
    "457191": "CELESTIAL",
    "458101": "DIVINE",
    "458111": "DIVINE",
    "458121": "DIVINE",
    "458131": "DIVINE",
    "458141": "DIVINE",
    "458151": "DIVINE",
    "458161": "DIVINE",
    "458171": "DIVINE",
    "458181": "DIVINE",
    "458191": "DIVINE",
    "459121": "COSMIC",
    "459131": "COSMIC",
    "459141": "COSMIC",
    "459151": "COSMIC",
    "459161": "COSMIC",
    "459171": "COSMIC",
    "459181": "COSMIC",
    "459191": "COSMIC",
    "500001": "COMMON",
    "500002": "COMMON",
    "500003": "COMMON",
    "500004": "COMMON",
    "500005": "COMMON",
    "500006": "COMMON",
    "500007": "COMMON",
    "500008": "COMMON",
    "500009": "COMMON",
    "500010": "COMMON",
    "500011": "COMMON",
    "500012": "COMMON",
    "500013": "COMMON",
    "500014": "COMMON",
    "500015": "COMMON",
    "500016": "COMMON",
    "500017": "COMMON",
    "500018": "COMMON",
    "500019": "COMMON",
    "500020": "COMMON",
    "501011": "UNCOMMON",
    "501021": "UNCOMMON",
    "501031": "UNCOMMON",
    "501041": "UNCOMMON",
    "501051": "UNCOMMON",
    "501061": "UNCOMMON",
    "501071": "UNCOMMON",
    "501081": "UNCOMMON",
    "501091": "UNCOMMON",
    "501101": "UNCOMMON",
    "501111": "UNCOMMON",
    "501121": "UNCOMMON",
    "501131": "UNCOMMON",
    "501141": "UNCOMMON",
    "501151": "UNCOMMON",
    "501161": "UNCOMMON",
    "501171": "UNCOMMON",
    "501181": "UNCOMMON",
    "501191": "UNCOMMON",
    "502011": "RARE",
    "502021": "RARE",
    "502031": "RARE",
    "502041": "RARE",
    "502051": "RARE",
    "502061": "RARE",
    "502071": "RARE",
    "502081": "RARE",
    "502091": "RARE",
    "502101": "RARE",
    "502111": "RARE",
    "502121": "RARE",
    "502131": "RARE",
    "502141": "RARE",
    "502151": "RARE",
    "502161": "RARE",
    "502171": "RARE",
    "502181": "RARE",
    "502191": "RARE",
    "503011": "LEGENDARY",
    "503021": "LEGENDARY",
    "503031": "LEGENDARY",
    "503041": "LEGENDARY",
    "503051": "LEGENDARY",
    "503061": "LEGENDARY",
    "503071": "LEGENDARY",
    "503081": "LEGENDARY",
    "503091": "LEGENDARY",
    "503101": "LEGENDARY",
    "503111": "LEGENDARY",
    "503121": "LEGENDARY",
    "503131": "LEGENDARY",
    "503141": "LEGENDARY",
    "503151": "LEGENDARY",
    "503161": "LEGENDARY",
    "503171": "LEGENDARY",
    "503181": "LEGENDARY",
    "503191": "LEGENDARY",
    "504011": "IMMORTAL",
    "504021": "IMMORTAL",
    "504031": "IMMORTAL",
    "504041": "IMMORTAL",
    "504051": "IMMORTAL",
    "504061": "IMMORTAL",
    "504071": "IMMORTAL",
    "504081": "IMMORTAL",
    "504091": "IMMORTAL",
    "504101": "IMMORTAL",
    "504111": "IMMORTAL",
    "504121": "IMMORTAL",
    "504131": "IMMORTAL",
    "504141": "IMMORTAL",
    "504151": "IMMORTAL",
    "504161": "IMMORTAL",
    "504171": "IMMORTAL",
    "504181": "IMMORTAL",
    "504191": "IMMORTAL",
    "505041": "ARCANA",
    "505051": "ARCANA",
    "505061": "ARCANA",
    "505071": "ARCANA",
    "505081": "ARCANA",
    "505091": "ARCANA",
    "505101": "ARCANA",
    "505111": "ARCANA",
    "505121": "ARCANA",
    "505131": "ARCANA",
    "505141": "ARCANA",
    "505151": "ARCANA",
    "505161": "ARCANA",
    "505171": "ARCANA",
    "505181": "ARCANA",
    "505191": "ARCANA",
    "506061": "BEYOND",
    "506071": "BEYOND",
    "506081": "BEYOND",
    "506091": "BEYOND",
    "506101": "BEYOND",
    "506111": "BEYOND",
    "506121": "BEYOND",
    "506131": "BEYOND",
    "506141": "BEYOND",
    "506151": "BEYOND",
    "506161": "BEYOND",
    "506171": "BEYOND",
    "506181": "BEYOND",
    "506191": "BEYOND",
    "507081": "CELESTIAL",
    "507091": "CELESTIAL",
    "507101": "CELESTIAL",
    "507111": "CELESTIAL",
    "507121": "CELESTIAL",
    "507131": "CELESTIAL",
    "507141": "CELESTIAL",
    "507151": "CELESTIAL",
    "507161": "CELESTIAL",
    "507171": "CELESTIAL",
    "507181": "CELESTIAL",
    "507191": "CELESTIAL",
    "508101": "DIVINE",
    "508111": "DIVINE",
    "508121": "DIVINE",
    "508131": "DIVINE",
    "508141": "DIVINE",
    "508151": "DIVINE",
    "508161": "DIVINE",
    "508171": "DIVINE",
    "508181": "DIVINE",
    "508191": "DIVINE",
    "509121": "COSMIC",
    "509131": "COSMIC",
    "509141": "COSMIC",
    "509151": "COSMIC",
    "509161": "COSMIC",
    "509171": "COSMIC",
    "509181": "COSMIC",
    "509191": "COSMIC",
    "510001": "COMMON",
    "510002": "COMMON",
    "510003": "COMMON",
    "510004": "COMMON",
    "510005": "COMMON",
    "510006": "COMMON",
    "510007": "COMMON",
    "510008": "COMMON",
    "510009": "COMMON",
    "510010": "COMMON",
    "510011": "COMMON",
    "510012": "COMMON",
    "510013": "COMMON",
    "510014": "COMMON",
    "510015": "COMMON",
    "510016": "COMMON",
    "510017": "COMMON",
    "510018": "COMMON",
    "510019": "COMMON",
    "510020": "COMMON",
    "511011": "UNCOMMON",
    "511021": "UNCOMMON",
    "511031": "UNCOMMON",
    "511041": "UNCOMMON",
    "511051": "UNCOMMON",
    "511061": "UNCOMMON",
    "511071": "UNCOMMON",
    "511081": "UNCOMMON",
    "511091": "UNCOMMON",
    "511101": "UNCOMMON",
    "511111": "UNCOMMON",
    "511121": "UNCOMMON",
    "511131": "UNCOMMON",
    "511141": "UNCOMMON",
    "511151": "UNCOMMON",
    "511161": "UNCOMMON",
    "511171": "UNCOMMON",
    "511181": "UNCOMMON",
    "511191": "UNCOMMON",
    "512011": "RARE",
    "512021": "RARE",
    "512031": "RARE",
    "512041": "RARE",
    "512051": "RARE",
    "512061": "RARE",
    "512071": "RARE",
    "512081": "RARE",
    "512091": "RARE",
    "512101": "RARE",
    "512111": "RARE",
    "512121": "RARE",
    "512131": "RARE",
    "512141": "RARE",
    "512151": "RARE",
    "512161": "RARE",
    "512171": "RARE",
    "512181": "RARE",
    "512191": "RARE",
    "513011": "LEGENDARY",
    "513021": "LEGENDARY",
    "513031": "LEGENDARY",
    "513041": "LEGENDARY",
    "513051": "LEGENDARY",
    "513061": "LEGENDARY",
    "513071": "LEGENDARY",
    "513081": "LEGENDARY",
    "513091": "LEGENDARY",
    "513101": "LEGENDARY",
    "513111": "LEGENDARY",
    "513121": "LEGENDARY",
    "513131": "LEGENDARY",
    "513141": "LEGENDARY",
    "513151": "LEGENDARY",
    "513161": "LEGENDARY",
    "513171": "LEGENDARY",
    "513181": "LEGENDARY",
    "513191": "LEGENDARY",
    "514011": "IMMORTAL",
    "514021": "IMMORTAL",
    "514031": "IMMORTAL",
    "514041": "IMMORTAL",
    "514051": "IMMORTAL",
    "514061": "IMMORTAL",
    "514071": "IMMORTAL",
    "514081": "IMMORTAL",
    "514091": "IMMORTAL",
    "514101": "IMMORTAL",
    "514111": "IMMORTAL",
    "514121": "IMMORTAL",
    "514131": "IMMORTAL",
    "514141": "IMMORTAL",
    "514151": "IMMORTAL",
    "514161": "IMMORTAL",
    "514171": "IMMORTAL",
    "514181": "IMMORTAL",
    "514191": "IMMORTAL",
    "515041": "ARCANA",
    "515051": "ARCANA",
    "515061": "ARCANA",
    "515071": "ARCANA",
    "515081": "ARCANA",
    "515091": "ARCANA",
    "515101": "ARCANA",
    "515111": "ARCANA",
    "515121": "ARCANA",
    "515131": "ARCANA",
    "515141": "ARCANA",
    "515151": "ARCANA",
    "515161": "ARCANA",
    "515171": "ARCANA",
    "515181": "ARCANA",
    "515191": "ARCANA",
    "516061": "BEYOND",
    "516071": "BEYOND",
    "516081": "BEYOND",
    "516091": "BEYOND",
    "516101": "BEYOND",
    "516111": "BEYOND",
    "516121": "BEYOND",
    "516131": "BEYOND",
    "516141": "BEYOND",
    "516151": "BEYOND",
    "516161": "BEYOND",
    "516171": "BEYOND",
    "516181": "BEYOND",
    "516191": "BEYOND",
    "517081": "CELESTIAL",
    "517091": "CELESTIAL",
    "517101": "CELESTIAL",
    "517111": "CELESTIAL",
    "517121": "CELESTIAL",
    "517131": "CELESTIAL",
    "517141": "CELESTIAL",
    "517151": "CELESTIAL",
    "517161": "CELESTIAL",
    "517171": "CELESTIAL",
    "517181": "CELESTIAL",
    "517191": "CELESTIAL",
    "518101": "DIVINE",
    "518111": "DIVINE",
    "518121": "DIVINE",
    "518131": "DIVINE",
    "518141": "DIVINE",
    "518151": "DIVINE",
    "518161": "DIVINE",
    "518171": "DIVINE",
    "518181": "DIVINE",
    "518191": "DIVINE",
    "519121": "COSMIC",
    "519131": "COSMIC",
    "519141": "COSMIC",
    "519151": "COSMIC",
    "519161": "COSMIC",
    "519171": "COSMIC",
    "519181": "COSMIC",
    "519191": "COSMIC",
    "520001": "COMMON",
    "520002": "COMMON",
    "520003": "COMMON",
    "520004": "COMMON",
    "520005": "COMMON",
    "520006": "COMMON",
    "520007": "COMMON",
    "520008": "COMMON",
    "520009": "COMMON",
    "520010": "COMMON",
    "520011": "COMMON",
    "520012": "COMMON",
    "520013": "COMMON",
    "520014": "COMMON",
    "520015": "COMMON",
    "520016": "COMMON",
    "520017": "COMMON",
    "520018": "COMMON",
    "520019": "COMMON",
    "520020": "COMMON",
    "521011": "UNCOMMON",
    "521021": "UNCOMMON",
    "521031": "UNCOMMON",
    "521041": "UNCOMMON",
    "521051": "UNCOMMON",
    "521061": "UNCOMMON",
    "521071": "UNCOMMON",
    "521081": "UNCOMMON",
    "521091": "UNCOMMON",
    "521101": "UNCOMMON",
    "521111": "UNCOMMON",
    "521121": "UNCOMMON",
    "521131": "UNCOMMON",
    "521141": "UNCOMMON",
    "521151": "UNCOMMON",
    "521161": "UNCOMMON",
    "521171": "UNCOMMON",
    "521181": "UNCOMMON",
    "521191": "UNCOMMON",
    "522011": "RARE",
    "522021": "RARE",
    "522031": "RARE",
    "522041": "RARE",
    "522051": "RARE",
    "522061": "RARE",
    "522071": "RARE",
    "522081": "RARE",
    "522091": "RARE",
    "522101": "RARE",
    "522111": "RARE",
    "522121": "RARE",
    "522131": "RARE",
    "522141": "RARE",
    "522151": "RARE",
    "522161": "RARE",
    "522171": "RARE",
    "522181": "RARE",
    "522191": "RARE",
    "523011": "LEGENDARY",
    "523021": "LEGENDARY",
    "523031": "LEGENDARY",
    "523041": "LEGENDARY",
    "523051": "LEGENDARY",
    "523061": "LEGENDARY",
    "523071": "LEGENDARY",
    "523081": "LEGENDARY",
    "523091": "LEGENDARY",
    "523101": "LEGENDARY",
    "523111": "LEGENDARY",
    "523121": "LEGENDARY",
    "523131": "LEGENDARY",
    "523141": "LEGENDARY",
    "523151": "LEGENDARY",
    "523161": "LEGENDARY",
    "523171": "LEGENDARY",
    "523181": "LEGENDARY",
    "523191": "LEGENDARY",
    "524011": "IMMORTAL",
    "524021": "IMMORTAL",
    "524031": "IMMORTAL",
    "524041": "IMMORTAL",
    "524051": "IMMORTAL",
    "524061": "IMMORTAL",
    "524071": "IMMORTAL",
    "524081": "IMMORTAL",
    "524091": "IMMORTAL",
    "524101": "IMMORTAL",
    "524111": "IMMORTAL",
    "524121": "IMMORTAL",
    "524131": "IMMORTAL",
    "524141": "IMMORTAL",
    "524151": "IMMORTAL",
    "524161": "IMMORTAL",
    "524171": "IMMORTAL",
    "524181": "IMMORTAL",
    "524191": "IMMORTAL",
    "525041": "ARCANA",
    "525051": "ARCANA",
    "525061": "ARCANA",
    "525071": "ARCANA",
    "525081": "ARCANA",
    "525091": "ARCANA",
    "525101": "ARCANA",
    "525111": "ARCANA",
    "525121": "ARCANA",
    "525131": "ARCANA",
    "525141": "ARCANA",
    "525151": "ARCANA",
    "525161": "ARCANA",
    "525171": "ARCANA",
    "525181": "ARCANA",
    "525191": "ARCANA",
    "526061": "BEYOND",
    "526071": "BEYOND",
    "526081": "BEYOND",
    "526091": "BEYOND",
    "526101": "BEYOND",
    "526111": "BEYOND",
    "526121": "BEYOND",
    "526131": "BEYOND",
    "526141": "BEYOND",
    "526151": "BEYOND",
    "526161": "BEYOND",
    "526171": "BEYOND",
    "526181": "BEYOND",
    "526191": "BEYOND",
    "527081": "CELESTIAL",
    "527091": "CELESTIAL",
    "527101": "CELESTIAL",
    "527111": "CELESTIAL",
    "527121": "CELESTIAL",
    "527131": "CELESTIAL",
    "527141": "CELESTIAL",
    "527151": "CELESTIAL",
    "527161": "CELESTIAL",
    "527171": "CELESTIAL",
    "527181": "CELESTIAL",
    "527191": "CELESTIAL",
    "528101": "DIVINE",
    "528111": "DIVINE",
    "528121": "DIVINE",
    "528131": "DIVINE",
    "528141": "DIVINE",
    "528151": "DIVINE",
    "528161": "DIVINE",
    "528171": "DIVINE",
    "528181": "DIVINE",
    "528191": "DIVINE",
    "529121": "COSMIC",
    "529131": "COSMIC",
    "529141": "COSMIC",
    "529151": "COSMIC",
    "529161": "COSMIC",
    "529171": "COSMIC",
    "529181": "COSMIC",
    "529191": "COSMIC",
    "530001": "COMMON",
    "530002": "COMMON",
    "530003": "COMMON",
    "530004": "COMMON",
    "530005": "COMMON",
    "530006": "COMMON",
    "530007": "COMMON",
    "530008": "COMMON",
    "530009": "COMMON",
    "530010": "COMMON",
    "530011": "COMMON",
    "530012": "COMMON",
    "530013": "COMMON",
    "530014": "COMMON",
    "530015": "COMMON",
    "530016": "COMMON",
    "530017": "COMMON",
    "530018": "COMMON",
    "530019": "COMMON",
    "530020": "COMMON",
    "531011": "UNCOMMON",
    "531021": "UNCOMMON",
    "531031": "UNCOMMON",
    "531041": "UNCOMMON",
    "531051": "UNCOMMON",
    "531061": "UNCOMMON",
    "531071": "UNCOMMON",
    "531081": "UNCOMMON",
    "531091": "UNCOMMON",
    "531101": "UNCOMMON",
    "531111": "UNCOMMON",
    "531121": "UNCOMMON",
    "531131": "UNCOMMON",
    "531141": "UNCOMMON",
    "531151": "UNCOMMON",
    "531161": "UNCOMMON",
    "531171": "UNCOMMON",
    "531181": "UNCOMMON",
    "531191": "UNCOMMON",
    "532011": "RARE",
    "532021": "RARE",
    "532031": "RARE",
    "532041": "RARE",
    "532051": "RARE",
    "532061": "RARE",
    "532071": "RARE",
    "532081": "RARE",
    "532091": "RARE",
    "532101": "RARE",
    "532111": "RARE",
    "532121": "RARE",
    "532131": "RARE",
    "532141": "RARE",
    "532151": "RARE",
    "532161": "RARE",
    "532171": "RARE",
    "532181": "RARE",
    "532191": "RARE",
    "533011": "LEGENDARY",
    "533021": "LEGENDARY",
    "533031": "LEGENDARY",
    "533041": "LEGENDARY",
    "533051": "LEGENDARY",
    "533061": "LEGENDARY",
    "533071": "LEGENDARY",
    "533081": "LEGENDARY",
    "533091": "LEGENDARY",
    "533101": "LEGENDARY",
    "533111": "LEGENDARY",
    "533121": "LEGENDARY",
    "533131": "LEGENDARY",
    "533141": "LEGENDARY",
    "533151": "LEGENDARY",
    "533161": "LEGENDARY",
    "533171": "LEGENDARY",
    "533181": "LEGENDARY",
    "533191": "LEGENDARY",
    "534011": "IMMORTAL",
    "534021": "IMMORTAL",
    "534031": "IMMORTAL",
    "534041": "IMMORTAL",
    "534051": "IMMORTAL",
    "534061": "IMMORTAL",
    "534071": "IMMORTAL",
    "534081": "IMMORTAL",
    "534091": "IMMORTAL",
    "534101": "IMMORTAL",
    "534111": "IMMORTAL",
    "534121": "IMMORTAL",
    "534131": "IMMORTAL",
    "534141": "IMMORTAL",
    "534151": "IMMORTAL",
    "534161": "IMMORTAL",
    "534171": "IMMORTAL",
    "534181": "IMMORTAL",
    "534191": "IMMORTAL",
    "535041": "ARCANA",
    "535051": "ARCANA",
    "535061": "ARCANA",
    "535071": "ARCANA",
    "535081": "ARCANA",
    "535091": "ARCANA",
    "535101": "ARCANA",
    "535111": "ARCANA",
    "535121": "ARCANA",
    "535131": "ARCANA",
    "535141": "ARCANA",
    "535151": "ARCANA",
    "535161": "ARCANA",
    "535171": "ARCANA",
    "535181": "ARCANA",
    "535191": "ARCANA",
    "536061": "BEYOND",
    "536071": "BEYOND",
    "536081": "BEYOND",
    "536091": "BEYOND",
    "536101": "BEYOND",
    "536111": "BEYOND",
    "536121": "BEYOND",
    "536131": "BEYOND",
    "536141": "BEYOND",
    "536151": "BEYOND",
    "536161": "BEYOND",
    "536171": "BEYOND",
    "536181": "BEYOND",
    "536191": "BEYOND",
    "537081": "CELESTIAL",
    "537091": "CELESTIAL",
    "537101": "CELESTIAL",
    "537111": "CELESTIAL",
    "537121": "CELESTIAL",
    "537131": "CELESTIAL",
    "537141": "CELESTIAL",
    "537151": "CELESTIAL",
    "537161": "CELESTIAL",
    "537171": "CELESTIAL",
    "537181": "CELESTIAL",
    "537191": "CELESTIAL",
    "538101": "DIVINE",
    "538111": "DIVINE",
    "538121": "DIVINE",
    "538131": "DIVINE",
    "538141": "DIVINE",
    "538151": "DIVINE",
    "538161": "DIVINE",
    "538171": "DIVINE",
    "538181": "DIVINE",
    "538191": "DIVINE",
    "539121": "COSMIC",
    "539131": "COSMIC",
    "539141": "COSMIC",
    "539151": "COSMIC",
    "539161": "COSMIC",
    "539171": "COSMIC",
    "539181": "COSMIC",
    "539191": "COSMIC",
    "601011": "UNCOMMON",
    "601021": "UNCOMMON",
    "601031": "UNCOMMON",
    "601041": "UNCOMMON",
    "601051": "UNCOMMON",
    "601061": "UNCOMMON",
    "601071": "UNCOMMON",
    "601081": "UNCOMMON",
    "601091": "UNCOMMON",
    "601101": "UNCOMMON",
    "601111": "UNCOMMON",
    "601121": "UNCOMMON",
    "601131": "UNCOMMON",
    "601141": "UNCOMMON",
    "601151": "UNCOMMON",
    "601161": "UNCOMMON",
    "601171": "UNCOMMON",
    "601181": "UNCOMMON",
    "601191": "UNCOMMON",
    "602011": "RARE",
    "602021": "RARE",
    "602031": "RARE",
    "602041": "RARE",
    "602051": "RARE",
    "602061": "RARE",
    "602071": "RARE",
    "602081": "RARE",
    "602091": "RARE",
    "602101": "RARE",
    "602111": "RARE",
    "602121": "RARE",
    "602131": "RARE",
    "602141": "RARE",
    "602151": "RARE",
    "602161": "RARE",
    "602171": "RARE",
    "602181": "RARE",
    "602191": "RARE",
    "603011": "LEGENDARY",
    "603021": "LEGENDARY",
    "603031": "LEGENDARY",
    "603041": "LEGENDARY",
    "603051": "LEGENDARY",
    "603061": "LEGENDARY",
    "603071": "LEGENDARY",
    "603081": "LEGENDARY",
    "603091": "LEGENDARY",
    "603101": "LEGENDARY",
    "603111": "LEGENDARY",
    "603121": "LEGENDARY",
    "603131": "LEGENDARY",
    "603141": "LEGENDARY",
    "603151": "LEGENDARY",
    "603161": "LEGENDARY",
    "603171": "LEGENDARY",
    "603181": "LEGENDARY",
    "603191": "LEGENDARY",
    "604011": "IMMORTAL",
    "604021": "IMMORTAL",
    "604031": "IMMORTAL",
    "604041": "IMMORTAL",
    "604051": "IMMORTAL",
    "604061": "IMMORTAL",
    "604071": "IMMORTAL",
    "604081": "IMMORTAL",
    "604091": "IMMORTAL",
    "604101": "IMMORTAL",
    "604111": "IMMORTAL",
    "604121": "IMMORTAL",
    "604131": "IMMORTAL",
    "604141": "IMMORTAL",
    "604151": "IMMORTAL",
    "604161": "IMMORTAL",
    "604171": "IMMORTAL",
    "604181": "IMMORTAL",
    "604191": "IMMORTAL",
    "605041": "ARCANA",
    "605051": "ARCANA",
    "605061": "ARCANA",
    "605071": "ARCANA",
    "605081": "ARCANA",
    "605091": "ARCANA",
    "605101": "ARCANA",
    "605111": "ARCANA",
    "605121": "ARCANA",
    "605131": "ARCANA",
    "605141": "ARCANA",
    "605151": "ARCANA",
    "605161": "ARCANA",
    "605171": "ARCANA",
    "605181": "ARCANA",
    "605191": "ARCANA",
    "606061": "BEYOND",
    "606071": "BEYOND",
    "606081": "BEYOND",
    "606091": "BEYOND",
    "606101": "BEYOND",
    "606111": "BEYOND",
    "606121": "BEYOND",
    "606131": "BEYOND",
    "606141": "BEYOND",
    "606151": "BEYOND",
    "606161": "BEYOND",
    "606171": "BEYOND",
    "606181": "BEYOND",
    "606191": "BEYOND",
    "607081": "CELESTIAL",
    "607091": "CELESTIAL",
    "607101": "CELESTIAL",
    "607111": "CELESTIAL",
    "607121": "CELESTIAL",
    "607131": "CELESTIAL",
    "607141": "CELESTIAL",
    "607151": "CELESTIAL",
    "607161": "CELESTIAL",
    "607171": "CELESTIAL",
    "607181": "CELESTIAL",
    "607191": "CELESTIAL",
    "608101": "DIVINE",
    "608111": "DIVINE",
    "608121": "DIVINE",
    "608131": "DIVINE",
    "608141": "DIVINE",
    "608151": "DIVINE",
    "608161": "DIVINE",
    "608171": "DIVINE",
    "608181": "DIVINE",
    "608191": "DIVINE",
    "609121": "COSMIC",
    "609131": "COSMIC",
    "609141": "COSMIC",
    "609151": "COSMIC",
    "609161": "COSMIC",
    "609171": "COSMIC",
    "609181": "COSMIC",
    "609191": "COSMIC",
    "611011": "UNCOMMON",
    "611021": "UNCOMMON",
    "611031": "UNCOMMON",
    "611041": "UNCOMMON",
    "611051": "UNCOMMON",
    "611061": "UNCOMMON",
    "611071": "UNCOMMON",
    "611081": "UNCOMMON",
    "611091": "UNCOMMON",
    "611101": "UNCOMMON",
    "611111": "UNCOMMON",
    "611121": "UNCOMMON",
    "611131": "UNCOMMON",
    "611141": "UNCOMMON",
    "611151": "UNCOMMON",
    "611161": "UNCOMMON",
    "611171": "UNCOMMON",
    "611181": "UNCOMMON",
    "611191": "UNCOMMON",
    "612011": "RARE",
    "612021": "RARE",
    "612031": "RARE",
    "612041": "RARE",
    "612051": "RARE",
    "612061": "RARE",
    "612071": "RARE",
    "612081": "RARE",
    "612091": "RARE",
    "612101": "RARE",
    "612111": "RARE",
    "612121": "RARE",
    "612131": "RARE",
    "612141": "RARE",
    "612151": "RARE",
    "612161": "RARE",
    "612171": "RARE",
    "612181": "RARE",
    "612191": "RARE",
    "613011": "LEGENDARY",
    "613021": "LEGENDARY",
    "613031": "LEGENDARY",
    "613041": "LEGENDARY",
    "613051": "LEGENDARY",
    "613061": "LEGENDARY",
    "613071": "LEGENDARY",
    "613081": "LEGENDARY",
    "613091": "LEGENDARY",
    "613101": "LEGENDARY",
    "613111": "LEGENDARY",
    "613121": "LEGENDARY",
    "613131": "LEGENDARY",
    "613141": "LEGENDARY",
    "613151": "LEGENDARY",
    "613161": "LEGENDARY",
    "613171": "LEGENDARY",
    "613181": "LEGENDARY",
    "613191": "LEGENDARY",
    "614011": "IMMORTAL",
    "614021": "IMMORTAL",
    "614031": "IMMORTAL",
    "614041": "IMMORTAL",
    "614051": "IMMORTAL",
    "614061": "IMMORTAL",
    "614071": "IMMORTAL",
    "614081": "IMMORTAL",
    "614091": "IMMORTAL",
    "614101": "IMMORTAL",
    "614111": "IMMORTAL",
    "614121": "IMMORTAL",
    "614131": "IMMORTAL",
    "614141": "IMMORTAL",
    "614151": "IMMORTAL",
    "614161": "IMMORTAL",
    "614171": "IMMORTAL",
    "614181": "IMMORTAL",
    "614191": "IMMORTAL",
    "615041": "ARCANA",
    "615051": "ARCANA",
    "615061": "ARCANA",
    "615071": "ARCANA",
    "615081": "ARCANA",
    "615091": "ARCANA",
    "615101": "ARCANA",
    "615111": "ARCANA",
    "615121": "ARCANA",
    "615131": "ARCANA",
    "615141": "ARCANA",
    "615151": "ARCANA",
    "615161": "ARCANA",
    "615171": "ARCANA",
    "615181": "ARCANA",
    "615191": "ARCANA",
    "616061": "BEYOND",
    "616071": "BEYOND",
    "616081": "BEYOND",
    "616091": "BEYOND",
    "616101": "BEYOND",
    "616111": "BEYOND",
    "616121": "BEYOND",
    "616131": "BEYOND",
    "616141": "BEYOND",
    "616151": "BEYOND",
    "616161": "BEYOND",
    "616171": "BEYOND",
    "616181": "BEYOND",
    "616191": "BEYOND",
    "617081": "CELESTIAL",
    "617091": "CELESTIAL",
    "617101": "CELESTIAL",
    "617111": "CELESTIAL",
    "617121": "CELESTIAL",
    "617131": "CELESTIAL",
    "617141": "CELESTIAL",
    "617151": "CELESTIAL",
    "617161": "CELESTIAL",
    "617171": "CELESTIAL",
    "617181": "CELESTIAL",
    "617191": "CELESTIAL",
    "618101": "DIVINE",
    "618111": "DIVINE",
    "618121": "DIVINE",
    "618131": "DIVINE",
    "618141": "DIVINE",
    "618151": "DIVINE",
    "618161": "DIVINE",
    "618171": "DIVINE",
    "618181": "DIVINE",
    "618191": "DIVINE",
    "619121": "COSMIC",
    "619131": "COSMIC",
    "619141": "COSMIC",
    "619151": "COSMIC",
    "619161": "COSMIC",
    "619171": "COSMIC",
    "619181": "COSMIC",
    "619191": "COSMIC",
    "621011": "UNCOMMON",
    "621021": "UNCOMMON",
    "621031": "UNCOMMON",
    "621041": "UNCOMMON",
    "621051": "UNCOMMON",
    "621061": "UNCOMMON",
    "621071": "UNCOMMON",
    "621081": "UNCOMMON",
    "621091": "UNCOMMON",
    "621101": "UNCOMMON",
    "621111": "UNCOMMON",
    "621121": "UNCOMMON",
    "621131": "UNCOMMON",
    "621141": "UNCOMMON",
    "621151": "UNCOMMON",
    "621161": "UNCOMMON",
    "621171": "UNCOMMON",
    "621181": "UNCOMMON",
    "621191": "UNCOMMON",
    "622011": "RARE",
    "622021": "RARE",
    "622031": "RARE",
    "622041": "RARE",
    "622051": "RARE",
    "622061": "RARE",
    "622071": "RARE",
    "622081": "RARE",
    "622091": "RARE",
    "622101": "RARE",
    "622111": "RARE",
    "622121": "RARE",
    "622131": "RARE",
    "622141": "RARE",
    "622151": "RARE",
    "622161": "RARE",
    "622171": "RARE",
    "622181": "RARE",
    "622191": "RARE",
    "623011": "LEGENDARY",
    "623021": "LEGENDARY",
    "623031": "LEGENDARY",
    "623041": "LEGENDARY",
    "623051": "LEGENDARY",
    "623061": "LEGENDARY",
    "623071": "LEGENDARY",
    "623081": "LEGENDARY",
    "623091": "LEGENDARY",
    "623101": "LEGENDARY",
    "623111": "LEGENDARY",
    "623121": "LEGENDARY",
    "623131": "LEGENDARY",
    "623141": "LEGENDARY",
    "623151": "LEGENDARY",
    "623161": "LEGENDARY",
    "623171": "LEGENDARY",
    "623181": "LEGENDARY",
    "623191": "LEGENDARY",
    "624011": "IMMORTAL",
    "624021": "IMMORTAL",
    "624031": "IMMORTAL",
    "624041": "IMMORTAL",
    "624051": "IMMORTAL",
    "624061": "IMMORTAL",
    "624071": "IMMORTAL",
    "624081": "IMMORTAL",
    "624091": "IMMORTAL",
    "624101": "IMMORTAL",
    "624111": "IMMORTAL",
    "624121": "IMMORTAL",
    "624131": "IMMORTAL",
    "624141": "IMMORTAL",
    "624151": "IMMORTAL",
    "624161": "IMMORTAL",
    "624171": "IMMORTAL",
    "624181": "IMMORTAL",
    "624191": "IMMORTAL",
    "625041": "ARCANA",
    "625051": "ARCANA",
    "625061": "ARCANA",
    "625071": "ARCANA",
    "625081": "ARCANA",
    "625091": "ARCANA",
    "625101": "ARCANA",
    "625111": "ARCANA",
    "625121": "ARCANA",
    "625131": "ARCANA",
    "625141": "ARCANA",
    "625151": "ARCANA",
    "625161": "ARCANA",
    "625171": "ARCANA",
    "625181": "ARCANA",
    "625191": "ARCANA",
    "626061": "BEYOND",
    "626071": "BEYOND",
    "626081": "BEYOND",
    "626091": "BEYOND",
    "626101": "BEYOND",
    "626111": "BEYOND",
    "626121": "BEYOND",
    "626131": "BEYOND",
    "626141": "BEYOND",
    "626151": "BEYOND",
    "626161": "BEYOND",
    "626171": "BEYOND",
    "626181": "BEYOND",
    "626191": "BEYOND",
    "627081": "CELESTIAL",
    "627091": "CELESTIAL",
    "627101": "CELESTIAL",
    "627111": "CELESTIAL",
    "627121": "CELESTIAL",
    "627131": "CELESTIAL",
    "627141": "CELESTIAL",
    "627151": "CELESTIAL",
    "627161": "CELESTIAL",
    "627171": "CELESTIAL",
    "627181": "CELESTIAL",
    "627191": "CELESTIAL",
    "628101": "DIVINE",
    "628111": "DIVINE",
    "628121": "DIVINE",
    "628131": "DIVINE",
    "628141": "DIVINE",
    "628151": "DIVINE",
    "628161": "DIVINE",
    "628171": "DIVINE",
    "628181": "DIVINE",
    "628191": "DIVINE",
    "629121": "COSMIC",
    "629131": "COSMIC",
    "629141": "COSMIC",
    "629151": "COSMIC",
    "629161": "COSMIC",
    "629171": "COSMIC",
    "629181": "COSMIC",
    "629191": "COSMIC",
    "631011": "UNCOMMON",
    "631021": "UNCOMMON",
    "631031": "UNCOMMON",
    "631041": "UNCOMMON",
    "631051": "UNCOMMON",
    "631061": "UNCOMMON",
    "631071": "UNCOMMON",
    "631081": "UNCOMMON",
    "631091": "UNCOMMON",
    "631101": "UNCOMMON",
    "631111": "UNCOMMON",
    "631121": "UNCOMMON",
    "631131": "UNCOMMON",
    "631141": "UNCOMMON",
    "631151": "UNCOMMON",
    "631161": "UNCOMMON",
    "631171": "UNCOMMON",
    "631181": "UNCOMMON",
    "631191": "UNCOMMON",
    "632011": "RARE",
    "632021": "RARE",
    "632031": "RARE",
    "632041": "RARE",
    "632051": "RARE",
    "632061": "RARE",
    "632071": "RARE",
    "632081": "RARE",
    "632091": "RARE",
    "632101": "RARE",
    "632111": "RARE",
    "632121": "RARE",
    "632131": "RARE",
    "632141": "RARE",
    "632151": "RARE",
    "632161": "RARE",
    "632171": "RARE",
    "632181": "RARE",
    "632191": "RARE",
    "633011": "LEGENDARY",
    "633021": "LEGENDARY",
    "633031": "LEGENDARY",
    "633041": "LEGENDARY",
    "633051": "LEGENDARY",
    "633061": "LEGENDARY",
    "633071": "LEGENDARY",
    "633081": "LEGENDARY",
    "633091": "LEGENDARY",
    "633101": "LEGENDARY",
    "633111": "LEGENDARY",
    "633121": "LEGENDARY",
    "633131": "LEGENDARY",
    "633141": "LEGENDARY",
    "633151": "LEGENDARY",
    "633161": "LEGENDARY",
    "633171": "LEGENDARY",
    "633181": "LEGENDARY",
    "633191": "LEGENDARY",
    "634011": "IMMORTAL",
    "634021": "IMMORTAL",
    "634031": "IMMORTAL",
    "634041": "IMMORTAL",
    "634051": "IMMORTAL",
    "634061": "IMMORTAL",
    "634071": "IMMORTAL",
    "634081": "IMMORTAL",
    "634091": "IMMORTAL",
    "634101": "IMMORTAL",
    "634111": "IMMORTAL",
    "634121": "IMMORTAL",
    "634131": "IMMORTAL",
    "634141": "IMMORTAL",
    "634151": "IMMORTAL",
    "634161": "IMMORTAL",
    "634171": "IMMORTAL",
    "634181": "IMMORTAL",
    "634191": "IMMORTAL",
    "635041": "ARCANA",
    "635051": "ARCANA",
    "635061": "ARCANA",
    "635071": "ARCANA",
    "635081": "ARCANA",
    "635091": "ARCANA",
    "635101": "ARCANA",
    "635111": "ARCANA",
    "635121": "ARCANA",
    "635131": "ARCANA",
    "635141": "ARCANA",
    "635151": "ARCANA",
    "635161": "ARCANA",
    "635171": "ARCANA",
    "635181": "ARCANA",
    "635191": "ARCANA",
    "636061": "BEYOND",
    "636071": "BEYOND",
    "636081": "BEYOND",
    "636091": "BEYOND",
    "636101": "BEYOND",
    "636111": "BEYOND",
    "636121": "BEYOND",
    "636131": "BEYOND",
    "636141": "BEYOND",
    "636151": "BEYOND",
    "636161": "BEYOND",
    "636171": "BEYOND",
    "636181": "BEYOND",
    "636191": "BEYOND",
    "637081": "CELESTIAL",
    "637091": "CELESTIAL",
    "637101": "CELESTIAL",
    "637111": "CELESTIAL",
    "637121": "CELESTIAL",
    "637131": "CELESTIAL",
    "637141": "CELESTIAL",
    "637151": "CELESTIAL",
    "637161": "CELESTIAL",
    "637171": "CELESTIAL",
    "637181": "CELESTIAL",
    "637191": "CELESTIAL",
    "638101": "DIVINE",
    "638111": "DIVINE",
    "638121": "DIVINE",
    "638131": "DIVINE",
    "638141": "DIVINE",
    "638151": "DIVINE",
    "638161": "DIVINE",
    "638171": "DIVINE",
    "638181": "DIVINE",
    "638191": "DIVINE",
    "639121": "COSMIC",
    "639131": "COSMIC",
    "639141": "COSMIC",
    "639151": "COSMIC",
    "639161": "COSMIC",
    "639171": "COSMIC",
    "639181": "COSMIC",
    "639191": "COSMIC",
    "910011": "COMMON",
    "910051": "COMMON",
    "910101": "COMMON",
    "910151": "COMMON",
    "910201": "COMMON",
    "910251": "COMMON",
    "910301": "COMMON",
    "910351": "COMMON",
    "910401": "COMMON",
    "910451": "COMMON",
    "910501": "COMMON",
    "910551": "COMMON",
    "910601": "COMMON",
    "910651": "COMMON",
    "910701": "COMMON",
    "910751": "COMMON",
    "910801": "COMMON",
    "910851": "COMMON",
    "910901": "COMMON",
    "920001": "RARE",
    "920002": "RARE",
    "920003": "RARE",
    "920004": "RARE",
    "920005": "RARE",
    "920006": "RARE",
    "920011": "RARE",
    "920022": "RARE",
    "920051": "RARE",
    "920101": "RARE",
    "920151": "RARE",
    "920201": "RARE",
    "920251": "RARE",
    "920301": "RARE",
    "920351": "RARE",
    "920401": "RARE",
    "920451": "RARE",
    "920501": "RARE",
    "920551": "RARE",
    "920601": "RARE",
    "920651": "RARE",
    "920701": "RARE",
    "920751": "RARE",
    "920801": "RARE",
    "920851": "RARE",
    "920901": "RARE",
    "930101": "LEGENDARY",
    "930201": "LEGENDARY",
    "930301": "LEGENDARY",
    "930401": "LEGENDARY",
    "930451": "LEGENDARY",
    "930501": "LEGENDARY",
    "930601": "LEGENDARY",
    "930651": "LEGENDARY",
    "930701": "LEGENDARY",
    "930851": "LEGENDARY",
    "930901": "LEGENDARY",
};
var g_nameMap = {
    "110001": "小红宝石",
    "110002": "小蓝宝石",
    "110003": "小黄玉",
    "110004": "小绿宝石",
    "110005": "小紫晶",
    "111001": "黑曜石碎片",
    "111002": "珊瑚碎片",
    "111003": "翡翠石",
    "111004": "琥珀宝石",
    "112001": "红宝石",
    "112002": "蓝宝石",
    "112003": "黄玉",
    "112004": "祖母绿",
    "112005": "紫水晶",
    "113001": "水晶石英",
    "113002": "珍珠",
    "113003": "绿松石",
    "113004": "石榴石",
    "114001": "钻石",
    "114002": "蛋白石",
    "114003": "青金石",
    "114004": "黑珍珠",
    "115001": "奥术水晶",
    "115002": "神秘黄玉",
    "115003": "附魔红宝石",
    "115004": "星光蓝宝石",
    "116001": "虚空蛋白石",
    "116002": "星辰钻石",
    "116003": "幽灵祖母绿",
    "116004": "暮光紫水晶",
    "117001": "天界珍珠",
    "117002": "龙晶石",
    "118001": "虚空水晶",
    "118002": "深渊珍珠",
    "119001": "以太宝石",
    "119002": "混沌钻石",
    "120001": "哥布林兽皮",
    "120002": "骸骨",
    "120003": "史莱姆果冻",
    "121001": "狼牙",
    "121002": "蜘蛛丝",
    "121003": "毒草",
    "121004": "治愈草药",
    "122001": "蝙蝠翼膜",
    "122002": "食人魔之血",
    "122003": "蘑菇孢子",
    "122004": "古树树液",
    "123001": "骷髅",
    "123002": "鹰身女妖羽毛",
    "123003": "曼德拉草根",
    "123004": "夜影精华",
    "124001": "毒蜥蜴鳞片",
    "124002": "飞龙之爪",
    "124003": "骰子",
    "124004": "恶魔之血",
    "125001": "牛头人之角",
    "125002": "狮鹫鸟喙",
    "125003": "不死鸟之灰",
    "125004": "龙胆汁",
    "126001": "幽灵精华",
    "126002": "海妖墨汁",
    "126003": "泰坦骨髓",
    "126004": "虚空精华",
    "127001": "深渊黏液",
    "127002": "混沌孢子",
    "128001": "太初树液",
    "128002": "不可名状之毒",
    "129001": "Chaso骰子",
    "129002": "虚空触须",
    "130001": "普通铭文卷轴",
    "131001": "非凡铭文卷轴",
    "132001": "稀有铭文卷轴",
    "133001": "传说铭文卷轴",
    "134001": "不朽铭文卷轴",
    "135001": "奥术铭文卷轴",
    "136001": "超越铭文卷轴",
    "137001": "天界铭文卷轴",
    "138001": "神圣铭文卷轴",
    "139001": "宇宙铭文卷轴",
    "140001": "木材",
    "140002": "石头",
    "140003": "皮革",
    "140004": "铜块",
    "141001": "青铜锭",
    "141002": "铁锭",
    "142001": "银锭",
    "142002": "金锭",
    "143001": "星尘锭",
    "143002": "虚空铁",
    "144001": "血石",
    "144002": "雷鸣石",
    "145001": "混沌碎片",
    "145002": "奥术矿石",
    "146001": "黑钢锭",
    "146002": "山铜矿石",
    "147001": "月长石",
    "147002": "太阳石",
    "148001": "秘银矿石",
    "148002": "以太锭",
    "149001": "精金矿石",
    "149002": "永恒锭",
    "150001": "",
    "150002": "",
    "150003": "",
    "150004": "",
    "150005": "",
    "150006": "",
    "150007": "",
    "150008": "",
    "150009": "",
    "150010": "",
    "160001": "王国一周年纪念币",
    "160002": "帝国一周年纪念币",
    "160003": "王国十周年纪念币",
    "160004": "帝国十周年纪念币",
    "160005": "王国50周年纪念币",
    "160006": "帝国建国50周年纪念币",
    "160007": "王国百年纪念币",
    "160008": "帝国百年纪念币",
    "160009": "神圣王国1000周年纪念币",
    "160010": "永恒帝国千年纪念硬币",
    "190001": "灵魂石 - 普通",
    "190002": "灵魂石 - 噩梦",
    "190003": "灵魂石 - 地狱",
    "190004": "灵魂石 - 折磨",
    "300001": "长剑",
    "300002": "弯刀",
    "300003": "细剑",
    "300004": "长阔剑",
    "300005": "大剑",
    "300006": "重型刀刃",
    "300007": "骑士之剑",
    "300008": "指挥官之剑",
    "300009": "符文剑",
    "300010": "传说之剑",
    "300011": "命运之剑",
    "300012": "英雄之剑",
    "300013": "风暴之剑",
    "300014": "复仇之剑",
    "300015": "虚空之刃",
    "300016": "水晶刀刃",
    "300017": "次元之剑",
    "300018": "暗影剑",
    "300019": "永恒之剑",
    "300020": "辉耀之剑",
    "301011": "长剑",
    "301021": "弯刀",
    "301031": "细剑",
    "301041": "长阔剑",
    "301051": "大剑",
    "301061": "重型刀刃",
    "301071": "骑士之剑",
    "301081": "指挥官之剑",
    "301091": "符文剑",
    "301101": "传说之剑",
    "301111": "命运之剑",
    "301121": "英雄之剑",
    "301131": "风暴之剑",
    "301141": "复仇之剑",
    "301151": "虚空之刃",
    "301161": "水晶刀刃",
    "301171": "次元之剑",
    "301181": "暗影剑",
    "301191": "永恒之剑",
    "302011": "长剑",
    "302021": "弯刀",
    "302031": "细剑",
    "302041": "长阔剑",
    "302051": "大剑",
    "302061": "重型刀刃",
    "302071": "骑士之剑",
    "302081": "指挥官之剑",
    "302091": "符文剑",
    "302101": "传说之剑",
    "302111": "命运之剑",
    "302121": "英雄之剑",
    "302131": "风暴之剑",
    "302141": "复仇之剑",
    "302151": "虚空之刃",
    "302161": "水晶刀刃",
    "302171": "次元之剑",
    "302181": "暗影剑",
    "302191": "永恒之剑",
    "303011": "长剑",
    "303021": "弯刀",
    "303031": "细剑",
    "303041": "长阔剑",
    "303051": "大剑",
    "303061": "重型刀刃",
    "303071": "骑士之剑",
    "303081": "指挥官之剑",
    "303091": "符文剑",
    "303101": "传说之剑",
    "303111": "命运之剑",
    "303121": "英雄之剑",
    "303131": "风暴之剑",
    "303141": "复仇之剑",
    "303151": "虚空之刃",
    "303161": "水晶刀刃",
    "303171": "次元之剑",
    "303181": "暗影剑",
    "303191": "永恒之剑",
    "304011": "长剑",
    "304021": "弯刀",
    "304031": "细剑",
    "304041": "长阔剑",
    "304051": "大剑",
    "304061": "重型刀刃",
    "304071": "骑士之剑",
    "304081": "指挥官之剑",
    "304091": "符文剑",
    "304101": "传说之剑",
    "304111": "命运之剑",
    "304121": "英雄之剑",
    "304131": "风暴之剑",
    "304141": "复仇之剑",
    "304151": "虚空之刃",
    "304161": "水晶刀刃",
    "304171": "次元之剑",
    "304181": "暗影剑",
    "304191": "永恒之剑",
    "305041": "长阔剑",
    "305051": "大剑",
    "305061": "重型刀刃",
    "305071": "骑士之剑",
    "305081": "指挥官之剑",
    "305091": "符文剑",
    "305101": "传说之剑",
    "305111": "命运之剑",
    "305121": "英雄之剑",
    "305131": "风暴之剑",
    "305141": "复仇之剑",
    "305151": "虚空之刃",
    "305161": "水晶刀刃",
    "305171": "次元之剑",
    "305181": "暗影剑",
    "305191": "永恒之剑",
    "306061": "重型刀刃",
    "306071": "骑士之剑",
    "306081": "指挥官之剑",
    "306091": "符文剑",
    "306101": "传说之剑",
    "306111": "命运之剑",
    "306121": "英雄之剑",
    "306131": "风暴之剑",
    "306141": "复仇之剑",
    "306151": "虚空之刃",
    "306161": "水晶刀刃",
    "306171": "次元之剑",
    "306181": "暗影剑",
    "306191": "永恒之剑",
    "307081": "指挥官之剑",
    "307091": "符文剑",
    "307101": "传说之剑",
    "307111": "命运之剑",
    "307121": "英雄之剑",
    "307131": "风暴之剑",
    "307141": "复仇之剑",
    "307151": "虚空之刃",
    "307161": "水晶刀刃",
    "307171": "次元之剑",
    "307181": "暗影剑",
    "307191": "永恒之剑",
    "308101": "传说之剑",
    "308111": "命运之剑",
    "308121": "英雄之剑",
    "308131": "风暴之剑",
    "308141": "复仇之剑",
    "308151": "虚空之刃",
    "308161": "水晶刀刃",
    "308171": "次元之剑",
    "308181": "暗影剑",
    "308191": "永恒之剑",
    "309121": "英雄之剑",
    "309131": "风暴之剑",
    "309141": "复仇之剑",
    "309151": "虚空之刃",
    "309161": "水晶刀刃",
    "309171": "次元之剑",
    "309181": "暗影剑",
    "309191": "永恒之剑",
    "310001": "短弓",
    "310002": "狩猎弓",
    "310003": "长弓",
    "310004": "复合弓",
    "310005": "战弓",
    "310006": "绯红之弓",
    "310007": "黄昏之弓",
    "310008": "翡翠弓",
    "310009": "精英弓",
    "310010": "符文弓",
    "310011": "神秘之弓",
    "310012": "迅捷弓",
    "310013": "远古弓",
    "310014": "无限弓",
    "310015": "混沌之弓",
    "310016": "暴风之弓",
    "310017": "暗影之弓",
    "310018": "暴风弓",
    "310019": "永恒之弓",
    "310020": "辉耀弓",
    "311011": "短弓",
    "311021": "狩猎弓",
    "311031": "长弓",
    "311041": "复合弓",
    "311051": "战弓",
    "311061": "绯红之弓",
    "311071": "黄昏之弓",
    "311081": "翡翠弓",
    "311091": "精英弓",
    "311101": "符文弓",
    "311111": "神秘之弓",
    "311121": "迅捷弓",
    "311131": "远古弓",
    "311141": "无限弓",
    "311151": "混沌之弓",
    "311161": "暴风之弓",
    "311171": "暗影之弓",
    "311181": "暴风弓",
    "311191": "永恒之弓",
    "312011": "短弓",
    "312021": "狩猎弓",
    "312031": "长弓",
    "312041": "复合弓",
    "312051": "战弓",
    "312061": "绯红之弓",
    "312071": "黄昏之弓",
    "312081": "翡翠弓",
    "312091": "精英弓",
    "312101": "符文弓",
    "312111": "神秘之弓",
    "312121": "迅捷弓",
    "312131": "远古弓",
    "312141": "无限弓",
    "312151": "混沌之弓",
    "312161": "暴风之弓",
    "312171": "暗影之弓",
    "312181": "暴风弓",
    "312191": "永恒之弓",
    "313011": "短弓",
    "313021": "狩猎弓",
    "313031": "长弓",
    "313041": "复合弓",
    "313051": "战弓",
    "313061": "绯红之弓",
    "313071": "黄昏之弓",
    "313081": "翡翠弓",
    "313091": "精英弓",
    "313101": "符文弓",
    "313111": "神秘之弓",
    "313121": "迅捷弓",
    "313131": "远古弓",
    "313141": "无限弓",
    "313151": "混沌之弓",
    "313161": "暴风之弓",
    "313171": "暗影之弓",
    "313181": "暴风弓",
    "313191": "永恒之弓",
    "314011": "短弓",
    "314021": "狩猎弓",
    "314031": "长弓",
    "314041": "复合弓",
    "314051": "战弓",
    "314061": "绯红之弓",
    "314071": "黄昏之弓",
    "314081": "翡翠弓",
    "314091": "精英弓",
    "314101": "符文弓",
    "314111": "神秘之弓",
    "314121": "迅捷弓",
    "314131": "远古弓",
    "314141": "无限弓",
    "314151": "混沌之弓",
    "314161": "暴风之弓",
    "314171": "暗影之弓",
    "314181": "暴风弓",
    "314191": "永恒之弓",
    "315041": "复合弓",
    "315051": "战弓",
    "315061": "绯红之弓",
    "315071": "黄昏之弓",
    "315081": "翡翠弓",
    "315091": "精英弓",
    "315101": "符文弓",
    "315111": "神秘之弓",
    "315121": "迅捷弓",
    "315131": "远古弓",
    "315141": "无限弓",
    "315151": "混沌之弓",
    "315161": "暴风之弓",
    "315171": "暗影之弓",
    "315181": "暴风弓",
    "315191": "永恒之弓",
    "316061": "绯红之弓",
    "316071": "黄昏之弓",
    "316081": "翡翠弓",
    "316091": "精英弓",
    "316101": "符文弓",
    "316111": "神秘之弓",
    "316121": "迅捷弓",
    "316131": "远古弓",
    "316141": "无限弓",
    "316151": "混沌之弓",
    "316161": "暴风之弓",
    "316171": "暗影之弓",
    "316181": "暴风弓",
    "316191": "永恒之弓",
    "317081": "翡翠弓",
    "317091": "精英弓",
    "317101": "符文弓",
    "317111": "神秘之弓",
    "317121": "迅捷弓",
    "317131": "远古弓",
    "317141": "无限弓",
    "317151": "混沌之弓",
    "317161": "暴风之弓",
    "317171": "暗影之弓",
    "317181": "暴风弓",
    "317191": "永恒之弓",
    "318101": "符文弓",
    "318111": "神秘之弓",
    "318121": "迅捷弓",
    "318131": "远古弓",
    "318141": "无限弓",
    "318151": "混沌之弓",
    "318161": "暴风之弓",
    "318171": "暗影之弓",
    "318181": "暴风弓",
    "318191": "永恒之弓",
    "319121": "迅捷弓",
    "319131": "远古弓",
    "319141": "无限弓",
    "319151": "混沌之弓",
    "319161": "暴风之弓",
    "319171": "暗影之弓",
    "319181": "暴风弓",
    "319191": "永恒之弓",
    "320001": "木制法杖",
    "320002": "传令使法杖",
    "320003": "长杖",
    "320004": "女巫法杖",
    "320005": "蔚蓝法杖",
    "320006": "长老之杖",
    "320007": "贤者之杖",
    "320008": "神秘法杖",
    "320009": "彗星法杖",
    "320010": "水晶法杖",
    "320011": "虚空法杖",
    "320012": "征服者法杖",
    "320013": "远古法杖",
    "320014": "神圣法杖",
    "320015": "深渊法杖",
    "320016": "混沌之杖",
    "320017": "暴风之杖",
    "320018": "新星法杖",
    "320019": "永恒法杖",
    "320020": "辉耀法杖",
    "321011": "木制法杖",
    "321021": "传令使法杖",
    "321031": "长杖",
    "321041": "女巫法杖",
    "321051": "蔚蓝法杖",
    "321061": "长老之杖",
    "321071": "贤者之杖",
    "321081": "神秘法杖",
    "321091": "彗星法杖",
    "321101": "水晶法杖",
    "321111": "虚空法杖",
    "321121": "征服者法杖",
    "321131": "远古法杖",
    "321141": "神圣法杖",
    "321151": "深渊法杖",
    "321161": "混沌之杖",
    "321171": "暴风之杖",
    "321181": "新星法杖",
    "321191": "永恒法杖",
    "322011": "木制法杖",
    "322021": "传令使法杖",
    "322031": "长杖",
    "322041": "女巫法杖",
    "322051": "蔚蓝法杖",
    "322061": "长老之杖",
    "322071": "贤者之杖",
    "322081": "神秘法杖",
    "322091": "彗星法杖",
    "322101": "水晶法杖",
    "322111": "虚空法杖",
    "322121": "征服者法杖",
    "322131": "远古法杖",
    "322141": "神圣法杖",
    "322151": "深渊法杖",
    "322161": "混沌之杖",
    "322171": "暴风之杖",
    "322181": "新星法杖",
    "322191": "永恒法杖",
    "323011": "木制法杖",
    "323021": "传令使法杖",
    "323031": "长杖",
    "323041": "女巫法杖",
    "323051": "蔚蓝法杖",
    "323061": "长老之杖",
    "323071": "贤者之杖",
    "323081": "神秘法杖",
    "323091": "彗星法杖",
    "323101": "水晶法杖",
    "323111": "虚空法杖",
    "323121": "征服者法杖",
    "323131": "远古法杖",
    "323141": "神圣法杖",
    "323151": "深渊法杖",
    "323161": "混沌之杖",
    "323171": "暴风之杖",
    "323181": "新星法杖",
    "323191": "永恒法杖",
    "324011": "木制法杖",
    "324021": "传令使法杖",
    "324031": "长杖",
    "324041": "女巫法杖",
    "324051": "蔚蓝法杖",
    "324061": "长老之杖",
    "324071": "贤者之杖",
    "324081": "神秘法杖",
    "324091": "彗星法杖",
    "324101": "水晶法杖",
    "324111": "虚空法杖",
    "324121": "征服者法杖",
    "324131": "远古法杖",
    "324141": "神圣法杖",
    "324151": "深渊法杖",
    "324161": "混沌之杖",
    "324171": "暴风之杖",
    "324181": "新星法杖",
    "324191": "永恒法杖",
    "325041": "女巫法杖",
    "325051": "蔚蓝法杖",
    "325061": "长老之杖",
    "325071": "贤者之杖",
    "325081": "神秘法杖",
    "325091": "彗星法杖",
    "325101": "水晶法杖",
    "325111": "虚空法杖",
    "325121": "征服者法杖",
    "325131": "远古法杖",
    "325141": "神圣法杖",
    "325151": "深渊法杖",
    "325161": "混沌之杖",
    "325171": "暴风之杖",
    "325181": "新星法杖",
    "325191": "永恒法杖",
    "326061": "长老之杖",
    "326071": "贤者之杖",
    "326081": "神秘法杖",
    "326091": "彗星法杖",
    "326101": "水晶法杖",
    "326111": "虚空法杖",
    "326121": "征服者法杖",
    "326131": "远古法杖",
    "326141": "神圣法杖",
    "326151": "深渊法杖",
    "326161": "混沌之杖",
    "326171": "暴风之杖",
    "326181": "新星法杖",
    "326191": "永恒法杖",
    "327081": "神秘法杖",
    "327091": "彗星法杖",
    "327101": "水晶法杖",
    "327111": "虚空法杖",
    "327121": "征服者法杖",
    "327131": "远古法杖",
    "327141": "神圣法杖",
    "327151": "深渊法杖",
    "327161": "混沌之杖",
    "327171": "暴风之杖",
    "327181": "新星法杖",
    "327191": "永恒法杖",
    "328101": "水晶法杖",
    "328111": "虚空法杖",
    "328121": "征服者法杖",
    "328131": "远古法杖",
    "328141": "神圣法杖",
    "328151": "深渊法杖",
    "328161": "混沌之杖",
    "328171": "暴风之杖",
    "328181": "新星法杖",
    "328191": "永恒法杖",
    "329121": "征服者法杖",
    "329131": "远古法杖",
    "329141": "神圣法杖",
    "329151": "深渊法杖",
    "329161": "混沌之杖",
    "329171": "暴风之杖",
    "329181": "新星法杖",
    "329191": "永恒法杖",
    "330001": "新手权杖",
    "330002": "铁权杖",
    "330003": "祝福之杖",
    "330004": "钢铁权杖",
    "330005": "神圣权杖",
    "330006": "主教权杖",
    "330007": "虔诚权杖",
    "330008": "重型权杖",
    "330009": "符文权杖",
    "330010": "传说权杖",
    "330011": "命运权杖",
    "330012": "英雄权杖",
    "330013": "风暴权杖",
    "330014": "无限权杖",
    "330015": "混沌权杖",
    "330016": "力量权杖",
    "330017": "次元权杖",
    "330018": "暗影权杖",
    "330019": "永恒权杖",
    "330020": "辉耀权杖",
    "331011": "新手权杖",
    "331021": "铁权杖",
    "331031": "祝福之杖",
    "331041": "钢铁权杖",
    "331051": "神圣权杖",
    "331061": "主教权杖",
    "331071": "虔诚权杖",
    "331081": "重型权杖",
    "331091": "符文权杖",
    "331101": "传说权杖",
    "331111": "命运权杖",
    "331121": "英雄权杖",
    "331131": "风暴权杖",
    "331141": "无限权杖",
    "331151": "混沌权杖",
    "331161": "力量权杖",
    "331171": "次元权杖",
    "331181": "暗影权杖",
    "331191": "永恒权杖",
    "332011": "新手权杖",
    "332021": "铁权杖",
    "332031": "祝福之杖",
    "332041": "钢铁权杖",
    "332051": "神圣权杖",
    "332061": "主教权杖",
    "332071": "虔诚权杖",
    "332081": "重型权杖",
    "332091": "符文权杖",
    "332101": "传说权杖",
    "332111": "命运权杖",
    "332121": "英雄权杖",
    "332131": "风暴权杖",
    "332141": "无限权杖",
    "332151": "混沌权杖",
    "332161": "力量权杖",
    "332171": "次元权杖",
    "332181": "暗影权杖",
    "332191": "永恒权杖",
    "333011": "新手权杖",
    "333021": "铁权杖",
    "333031": "祝福之杖",
    "333041": "钢铁权杖",
    "333051": "神圣权杖",
    "333061": "主教权杖",
    "333071": "虔诚权杖",
    "333081": "重型权杖",
    "333091": "符文权杖",
    "333101": "传说权杖",
    "333111": "命运权杖",
    "333121": "英雄权杖",
    "333131": "风暴权杖",
    "333141": "无限权杖",
    "333151": "混沌权杖",
    "333161": "力量权杖",
    "333171": "次元权杖",
    "333181": "暗影权杖",
    "333191": "永恒权杖",
    "334011": "新手权杖",
    "334021": "铁权杖",
    "334031": "祝福之杖",
    "334041": "钢铁权杖",
    "334051": "神圣权杖",
    "334061": "主教权杖",
    "334071": "虔诚权杖",
    "334081": "重型权杖",
    "334091": "符文权杖",
    "334101": "传说权杖",
    "334111": "命运权杖",
    "334121": "英雄权杖",
    "334131": "风暴权杖",
    "334141": "无限权杖",
    "334151": "混沌权杖",
    "334161": "力量权杖",
    "334171": "次元权杖",
    "334181": "暗影权杖",
    "334191": "永恒权杖",
    "335041": "钢铁权杖",
    "335051": "神圣权杖",
    "335061": "主教权杖",
    "335071": "虔诚权杖",
    "335081": "重型权杖",
    "335091": "符文权杖",
    "335101": "传说权杖",
    "335111": "命运权杖",
    "335121": "英雄权杖",
    "335131": "风暴权杖",
    "335141": "无限权杖",
    "335151": "混沌权杖",
    "335161": "力量权杖",
    "335171": "次元权杖",
    "335181": "暗影权杖",
    "335191": "永恒权杖",
    "336061": "主教权杖",
    "336071": "虔诚权杖",
    "336081": "重型权杖",
    "336091": "符文权杖",
    "336101": "传说权杖",
    "336111": "命运权杖",
    "336121": "英雄权杖",
    "336131": "风暴权杖",
    "336141": "无限权杖",
    "336151": "混沌权杖",
    "336161": "力量权杖",
    "336171": "次元权杖",
    "336181": "暗影权杖",
    "336191": "永恒权杖",
    "337081": "重型权杖",
    "337091": "符文权杖",
    "337101": "传说权杖",
    "337111": "命运权杖",
    "337121": "英雄权杖",
    "337131": "风暴权杖",
    "337141": "无限权杖",
    "337151": "混沌权杖",
    "337161": "力量权杖",
    "337171": "次元权杖",
    "337181": "暗影权杖",
    "337191": "永恒权杖",
    "338101": "传说权杖",
    "338111": "命运权杖",
    "338121": "英雄权杖",
    "338131": "风暴权杖",
    "338141": "无限权杖",
    "338151": "混沌权杖",
    "338161": "力量权杖",
    "338171": "次元权杖",
    "338181": "暗影权杖",
    "338191": "永恒权杖",
    "339121": "英雄权杖",
    "339131": "风暴权杖",
    "339141": "无限权杖",
    "339151": "混沌权杖",
    "339161": "力量权杖",
    "339171": "次元权杖",
    "339181": "暗影权杖",
    "339191": "永恒权杖",
    "340001": "短弩",
    "340002": "皮革弩",
    "340003": "长弩",
    "340004": "完整弩",
    "340005": "卓越弩",
    "340006": "强化弩",
    "340007": "铁制弩",
    "340008": "羽翼弩",
    "340009": "精英弩",
    "340010": "大型弩",
    "340011": "神秘弩",
    "340012": "迅捷弩",
    "340013": "远古弩",
    "340014": "无限弩",
    "340015": "混沌弩",
    "340016": "力量弩",
    "340017": "次元弩",
    "340018": "暗影弩",
    "340019": "永恒弩",
    "340020": "辉耀弩",
    "341011": "短弩",
    "341021": "皮革弩",
    "341031": "长弩",
    "341041": "完整弩",
    "341051": "卓越弩",
    "341061": "强化弩",
    "341071": "铁制弩",
    "341081": "羽翼弩",
    "341091": "精英弩",
    "341101": "大型弩",
    "341111": "神秘弩",
    "341121": "迅捷弩",
    "341131": "远古弩",
    "341141": "无限弩",
    "341151": "混沌弩",
    "341161": "力量弩",
    "341171": "次元弩",
    "341181": "暗影弩",
    "341191": "永恒弩",
    "342011": "短弩",
    "342021": "皮革弩",
    "342031": "长弩",
    "342041": "完整弩",
    "342051": "卓越弩",
    "342061": "强化弩",
    "342071": "铁制弩",
    "342081": "羽翼弩",
    "342091": "精英弩",
    "342101": "大型弩",
    "342111": "神秘弩",
    "342121": "迅捷弩",
    "342131": "远古弩",
    "342141": "无限弩",
    "342151": "混沌弩",
    "342161": "力量弩",
    "342171": "次元弩",
    "342181": "暗影弩",
    "342191": "永恒弩",
    "343011": "短弩",
    "343021": "皮革弩",
    "343031": "长弩",
    "343041": "完整弩",
    "343051": "卓越弩",
    "343061": "强化弩",
    "343071": "铁制弩",
    "343081": "羽翼弩",
    "343091": "精英弩",
    "343101": "大型弩",
    "343111": "神秘弩",
    "343121": "迅捷弩",
    "343131": "远古弩",
    "343141": "无限弩",
    "343151": "混沌弩",
    "343161": "力量弩",
    "343171": "次元弩",
    "343181": "暗影弩",
    "343191": "永恒弩",
    "344011": "短弩",
    "344021": "皮革弩",
    "344031": "长弩",
    "344041": "完整弩",
    "344051": "卓越弩",
    "344061": "强化弩",
    "344071": "铁制弩",
    "344081": "羽翼弩",
    "344091": "精英弩",
    "344101": "大型弩",
    "344111": "神秘弩",
    "344121": "迅捷弩",
    "344131": "远古弩",
    "344141": "无限弩",
    "344151": "混沌弩",
    "344161": "力量弩",
    "344171": "次元弩",
    "344181": "暗影弩",
    "344191": "永恒弩",
    "345041": "完整弩",
    "345051": "卓越弩",
    "345061": "强化弩",
    "345071": "铁制弩",
    "345081": "羽翼弩",
    "345091": "精英弩",
    "345101": "大型弩",
    "345111": "神秘弩",
    "345121": "迅捷弩",
    "345131": "远古弩",
    "345141": "无限弩",
    "345151": "混沌弩",
    "345161": "力量弩",
    "345171": "次元弩",
    "345181": "暗影弩",
    "345191": "永恒弩",
    "346061": "强化弩",
    "346071": "铁制弩",
    "346081": "羽翼弩",
    "346091": "精英弩",
    "346101": "大型弩",
    "346111": "神秘弩",
    "346121": "迅捷弩",
    "346131": "远古弩",
    "346141": "无限弩",
    "346151": "混沌弩",
    "346161": "力量弩",
    "346171": "次元弩",
    "346181": "暗影弩",
    "346191": "永恒弩",
    "347081": "羽翼弩",
    "347091": "精英弩",
    "347101": "大型弩",
    "347111": "神秘弩",
    "347121": "迅捷弩",
    "347131": "远古弩",
    "347141": "无限弩",
    "347151": "混沌弩",
    "347161": "力量弩",
    "347171": "次元弩",
    "347181": "暗影弩",
    "347191": "永恒弩",
    "348101": "大型弩",
    "348111": "神秘弩",
    "348121": "迅捷弩",
    "348131": "远古弩",
    "348141": "无限弩",
    "348151": "混沌弩",
    "348161": "力量弩",
    "348171": "次元弩",
    "348181": "暗影弩",
    "348191": "永恒弩",
    "349121": "迅捷弩",
    "349131": "远古弩",
    "349141": "无限弩",
    "349151": "混沌弩",
    "349161": "力量弩",
    "349171": "次元弩",
    "349181": "暗影弩",
    "349191": "永恒弩",
    "350001": "木斧",
    "350002": "铁斧",
    "350003": "战斧",
    "350004": "钢铁斧",
    "350005": "战斧",
    "350006": "骑士之斧",
    "350007": "巨斧",
    "350008": "重型斧",
    "350009": "符文斧",
    "350010": "传说之斧",
    "350011": "命运之斧",
    "350012": "英雄之斧",
    "350013": "风暴战斧",
    "350014": "无限斧",
    "350015": "混沌之斧",
    "350016": "力量之斧",
    "350017": "次元斧",
    "350018": "暗影斧",
    "350019": "永恒斧",
    "350020": "辉耀之斧",
    "351011": "木斧",
    "351021": "铁斧",
    "351031": "战斧",
    "351041": "钢铁斧",
    "351051": "战斧",
    "351061": "骑士之斧",
    "351071": "巨斧",
    "351081": "重型斧",
    "351091": "符文斧",
    "351101": "传说之斧",
    "351111": "命运之斧",
    "351121": "英雄之斧",
    "351131": "风暴战斧",
    "351141": "无限斧",
    "351151": "混沌之斧",
    "351161": "力量之斧",
    "351171": "次元斧",
    "351181": "暗影斧",
    "351191": "永恒斧",
    "352011": "木斧",
    "352021": "铁斧",
    "352031": "战斧",
    "352041": "钢铁斧",
    "352051": "战斧",
    "352061": "骑士之斧",
    "352071": "巨斧",
    "352081": "重型斧",
    "352091": "符文斧",
    "352101": "传说之斧",
    "352111": "命运之斧",
    "352121": "英雄之斧",
    "352131": "风暴战斧",
    "352141": "无限斧",
    "352151": "混沌之斧",
    "352161": "力量之斧",
    "352171": "次元斧",
    "352181": "暗影斧",
    "352191": "永恒斧",
    "353011": "木斧",
    "353021": "铁斧",
    "353031": "战斧",
    "353041": "钢铁斧",
    "353051": "战斧",
    "353061": "骑士之斧",
    "353071": "巨斧",
    "353081": "重型斧",
    "353091": "符文斧",
    "353101": "传说之斧",
    "353111": "命运之斧",
    "353121": "英雄之斧",
    "353131": "风暴战斧",
    "353141": "无限斧",
    "353151": "混沌之斧",
    "353161": "力量之斧",
    "353171": "次元斧",
    "353181": "暗影斧",
    "353191": "永恒斧",
    "354011": "木斧",
    "354021": "铁斧",
    "354031": "战斧",
    "354041": "钢铁斧",
    "354051": "战斧",
    "354061": "骑士之斧",
    "354071": "巨斧",
    "354081": "重型斧",
    "354091": "符文斧",
    "354101": "传说之斧",
    "354111": "命运之斧",
    "354121": "英雄之斧",
    "354131": "风暴战斧",
    "354141": "无限斧",
    "354151": "混沌之斧",
    "354161": "力量之斧",
    "354171": "次元斧",
    "354181": "暗影斧",
    "354191": "永恒斧",
    "355041": "钢铁斧",
    "355051": "战斧",
    "355061": "骑士之斧",
    "355071": "巨斧",
    "355081": "重型斧",
    "355091": "符文斧",
    "355101": "传说之斧",
    "355111": "命运之斧",
    "355121": "英雄之斧",
    "355131": "风暴战斧",
    "355141": "无限斧",
    "355151": "混沌之斧",
    "355161": "力量之斧",
    "355171": "次元斧",
    "355181": "暗影斧",
    "355191": "永恒斧",
    "356061": "骑士之斧",
    "356071": "巨斧",
    "356081": "重型斧",
    "356091": "符文斧",
    "356101": "传说之斧",
    "356111": "命运之斧",
    "356121": "英雄之斧",
    "356131": "风暴战斧",
    "356141": "无限斧",
    "356151": "混沌之斧",
    "356161": "力量之斧",
    "356171": "次元斧",
    "356181": "暗影斧",
    "356191": "永恒斧",
    "357081": "重型斧",
    "357091": "符文斧",
    "357101": "传说之斧",
    "357111": "命运之斧",
    "357121": "英雄之斧",
    "357131": "风暴战斧",
    "357141": "无限斧",
    "357151": "混沌之斧",
    "357161": "力量之斧",
    "357171": "次元斧",
    "357181": "暗影斧",
    "357191": "永恒斧",
    "358101": "传说之斧",
    "358111": "命运之斧",
    "358121": "英雄之斧",
    "358131": "风暴战斧",
    "358141": "无限斧",
    "358151": "混沌之斧",
    "358161": "力量之斧",
    "358171": "次元斧",
    "358181": "暗影斧",
    "358191": "永恒斧",
    "359121": "英雄之斧",
    "359131": "风暴战斧",
    "359141": "无限斧",
    "359151": "混沌之斧",
    "359161": "力量之斧",
    "359171": "次元斧",
    "359181": "暗影斧",
    "359191": "永恒斧",
    "400001": "小圆盾",
    "400002": "木盾",
    "400003": "铁盾",
    "400004": "希特盾",
    "400005": "重盾",
    "400006": "森林之盾",
    "400007": "战争盾",
    "400008": "屏障盾",
    "400009": "精英盾",
    "400010": "赤红盾",
    "400011": "神秘盾牌",
    "400012": "大盾",
    "400013": "远古盾",
    "400014": "光辉盾",
    "400015": "虚空之盾",
    "400016": "神圣之盾",
    "400017": "次元盾",
    "400018": "暗影盾",
    "400019": "永恒盾",
    "400020": "龙盾",
    "401011": "小圆盾",
    "401021": "木盾",
    "401031": "铁盾",
    "401041": "希特盾",
    "401051": "重盾",
    "401061": "森林之盾",
    "401071": "战争盾",
    "401081": "屏障盾",
    "401091": "精英盾",
    "401101": "赤红盾",
    "401111": "神秘盾牌",
    "401121": "大盾",
    "401131": "远古盾",
    "401141": "光辉盾",
    "401151": "虚空之盾",
    "401161": "神圣之盾",
    "401171": "次元盾",
    "401181": "暗影盾",
    "401191": "永恒盾",
    "402011": "小圆盾",
    "402021": "木盾",
    "402031": "铁盾",
    "402041": "希特盾",
    "402051": "重盾",
    "402061": "森林之盾",
    "402071": "战争盾",
    "402081": "屏障盾",
    "402091": "精英盾",
    "402101": "赤红盾",
    "402111": "神秘盾牌",
    "402121": "大盾",
    "402131": "远古盾",
    "402141": "光辉盾",
    "402151": "虚空之盾",
    "402161": "神圣之盾",
    "402171": "次元盾",
    "402181": "暗影盾",
    "402191": "永恒盾",
    "403011": "小圆盾",
    "403021": "木盾",
    "403031": "铁盾",
    "403041": "希特盾",
    "403051": "重盾",
    "403061": "森林之盾",
    "403071": "战争盾",
    "403081": "屏障盾",
    "403091": "精英盾",
    "403101": "赤红盾",
    "403111": "神秘盾牌",
    "403121": "大盾",
    "403131": "远古盾",
    "403141": "光辉盾",
    "403151": "虚空之盾",
    "403161": "神圣之盾",
    "403171": "次元盾",
    "403181": "暗影盾",
    "403191": "永恒盾",
    "404011": "小圆盾",
    "404021": "木盾",
    "404031": "铁盾",
    "404041": "希特盾",
    "404051": "重盾",
    "404061": "森林之盾",
    "404071": "战争盾",
    "404081": "屏障盾",
    "404091": "精英盾",
    "404101": "赤红盾",
    "404111": "神秘盾牌",
    "404121": "大盾",
    "404131": "远古盾",
    "404141": "光辉盾",
    "404151": "虚空之盾",
    "404161": "神圣之盾",
    "404171": "次元盾",
    "404181": "暗影盾",
    "404191": "永恒盾",
    "405041": "希特盾",
    "405051": "重盾",
    "405061": "森林之盾",
    "405071": "战争盾",
    "405081": "屏障盾",
    "405091": "精英盾",
    "405101": "赤红盾",
    "405111": "神秘盾牌",
    "405121": "大盾",
    "405131": "远古盾",
    "405141": "光辉盾",
    "405151": "虚空之盾",
    "405161": "神圣之盾",
    "405171": "次元盾",
    "405181": "暗影盾",
    "405191": "永恒盾",
    "406061": "森林之盾",
    "406071": "战争盾",
    "406081": "屏障盾",
    "406091": "精英盾",
    "406101": "赤红盾",
    "406111": "神秘盾牌",
    "406121": "大盾",
    "406131": "远古盾",
    "406141": "光辉盾",
    "406151": "虚空之盾",
    "406161": "神圣之盾",
    "406171": "次元盾",
    "406181": "暗影盾",
    "406191": "永恒盾",
    "407081": "屏障盾",
    "407091": "精英盾",
    "407101": "赤红盾",
    "407111": "神秘盾牌",
    "407121": "大盾",
    "407131": "远古盾",
    "407141": "光辉盾",
    "407151": "虚空之盾",
    "407161": "神圣之盾",
    "407171": "次元盾",
    "407181": "暗影盾",
    "407191": "永恒盾",
    "408101": "赤红盾",
    "408111": "神秘盾牌",
    "408121": "大盾",
    "408131": "远古盾",
    "408141": "光辉盾",
    "408151": "虚空之盾",
    "408161": "神圣之盾",
    "408171": "次元盾",
    "408181": "暗影盾",
    "408191": "永恒盾",
    "409121": "大盾",
    "409131": "远古盾",
    "409141": "光辉盾",
    "409151": "虚空之盾",
    "409161": "神圣之盾",
    "409171": "次元盾",
    "409181": "暗影盾",
    "409191": "永恒盾",
    "410001": "木箭",
    "410002": "铁箭",
    "410003": "猎人之箭",
    "410004": "倒刺箭",
    "410005": "蔚蓝之箭",
    "410006": "野蛮箭矢",
    "410007": "疾风箭",
    "410008": "毒蛇箭",
    "410009": "符文箭",
    "410010": "部落箭",
    "410011": "命运之箭",
    "410012": "风暴箭",
    "410013": "黑曜石箭",
    "410014": "迅捷箭",
    "410015": "虚空之箭",
    "410016": "毒箭",
    "410017": "次元箭",
    "410018": "暗影箭",
    "410019": "古代箭",
    "410020": "崇高之箭",
    "411011": "木箭",
    "411021": "铁箭",
    "411031": "猎人之箭",
    "411041": "倒刺箭",
    "411051": "蔚蓝之箭",
    "411061": "野蛮箭矢",
    "411071": "疾风箭",
    "411081": "毒蛇箭",
    "411091": "符文箭",
    "411101": "部落箭",
    "411111": "命运之箭",
    "411121": "风暴箭",
    "411131": "黑曜石箭",
    "411141": "迅捷箭",
    "411151": "虚空之箭",
    "411161": "毒箭",
    "411171": "次元箭",
    "411181": "暗影箭",
    "411191": "古代箭",
    "412011": "木箭",
    "412021": "铁箭",
    "412031": "猎人之箭",
    "412041": "倒刺箭",
    "412051": "蔚蓝之箭",
    "412061": "野蛮箭矢",
    "412071": "疾风箭",
    "412081": "毒蛇箭",
    "412091": "符文箭",
    "412101": "部落箭",
    "412111": "命运之箭",
    "412121": "风暴箭",
    "412131": "黑曜石箭",
    "412141": "迅捷箭",
    "412151": "虚空之箭",
    "412161": "毒箭",
    "412171": "次元箭",
    "412181": "暗影箭",
    "412191": "古代箭",
    "413011": "木箭",
    "413021": "铁箭",
    "413031": "猎人之箭",
    "413041": "倒刺箭",
    "413051": "蔚蓝之箭",
    "413061": "野蛮箭矢",
    "413071": "疾风箭",
    "413081": "毒蛇箭",
    "413091": "符文箭",
    "413101": "部落箭",
    "413111": "命运之箭",
    "413121": "风暴箭",
    "413131": "黑曜石箭",
    "413141": "迅捷箭",
    "413151": "虚空之箭",
    "413161": "毒箭",
    "413171": "次元箭",
    "413181": "暗影箭",
    "413191": "古代箭",
    "414011": "木箭",
    "414021": "铁箭",
    "414031": "猎人之箭",
    "414041": "倒刺箭",
    "414051": "蔚蓝之箭",
    "414061": "野蛮箭矢",
    "414071": "疾风箭",
    "414081": "毒蛇箭",
    "414091": "符文箭",
    "414101": "部落箭",
    "414111": "命运之箭",
    "414121": "风暴箭",
    "414131": "黑曜石箭",
    "414141": "迅捷箭",
    "414151": "虚空之箭",
    "414161": "毒箭",
    "414171": "次元箭",
    "414181": "暗影箭",
    "414191": "古代箭",
    "415041": "倒刺箭",
    "415051": "蔚蓝之箭",
    "415061": "野蛮箭矢",
    "415071": "疾风箭",
    "415081": "毒蛇箭",
    "415091": "符文箭",
    "415101": "部落箭",
    "415111": "命运之箭",
    "415121": "风暴箭",
    "415131": "黑曜石箭",
    "415141": "迅捷箭",
    "415151": "虚空之箭",
    "415161": "毒箭",
    "415171": "次元箭",
    "415181": "暗影箭",
    "415191": "古代箭",
    "416061": "野蛮箭矢",
    "416071": "疾风箭",
    "416081": "毒蛇箭",
    "416091": "符文箭",
    "416101": "部落箭",
    "416111": "命运之箭",
    "416121": "风暴箭",
    "416131": "黑曜石箭",
    "416141": "迅捷箭",
    "416151": "虚空之箭",
    "416161": "毒箭",
    "416171": "次元箭",
    "416181": "暗影箭",
    "416191": "古代箭",
    "417081": "毒蛇箭",
    "417091": "符文箭",
    "417101": "部落箭",
    "417111": "命运之箭",
    "417121": "风暴箭",
    "417131": "黑曜石箭",
    "417141": "迅捷箭",
    "417151": "虚空之箭",
    "417161": "毒箭",
    "417171": "次元箭",
    "417181": "暗影箭",
    "417191": "古代箭",
    "418101": "部落箭",
    "418111": "命运之箭",
    "418121": "风暴箭",
    "418131": "黑曜石箭",
    "418141": "迅捷箭",
    "418151": "虚空之箭",
    "418161": "毒箭",
    "418171": "次元箭",
    "418181": "暗影箭",
    "418191": "古代箭",
    "419121": "风暴箭",
    "419131": "黑曜石箭",
    "419141": "迅捷箭",
    "419151": "虚空之箭",
    "419161": "毒箭",
    "419171": "次元箭",
    "419181": "暗影箭",
    "419191": "古代箭",
    "420001": "魔法宝珠",
    "420002": "长老法球",
    "420003": "辉煌宝球",
    "420004": "冰冻法球",
    "420005": "预言宝珠",
    "420006": "暗黑法球",
    "420007": "符文宝珠",
    "420008": "闪耀法球",
    "420009": "奥术法球",
    "420010": "命运法球",
    "420011": "神秘宝珠",
    "420012": "天空法球",
    "420013": "灵魂宝球",
    "420014": "远古法球",
    "420015": "深渊宝珠",
    "420016": "虚空法球",
    "420017": "次元宝珠",
    "420018": "暗影法球",
    "420019": "永恒法球",
    "420020": "金辉法球",
    "421011": "魔法宝珠",
    "421021": "长老法球",
    "421031": "辉煌宝球",
    "421041": "冰冻法球",
    "421051": "预言宝珠",
    "421061": "暗黑法球",
    "421071": "符文宝珠",
    "421081": "闪耀法球",
    "421091": "奥术法球",
    "421101": "命运法球",
    "421111": "神秘宝珠",
    "421121": "天空法球",
    "421131": "灵魂宝球",
    "421141": "远古法球",
    "421151": "深渊宝珠",
    "421161": "虚空法球",
    "421171": "次元宝珠",
    "421181": "暗影法球",
    "421191": "永恒法球",
    "422011": "魔法宝珠",
    "422021": "长老法球",
    "422031": "辉煌宝球",
    "422041": "冰冻法球",
    "422051": "预言宝珠",
    "422061": "暗黑法球",
    "422071": "符文宝珠",
    "422081": "闪耀法球",
    "422091": "奥术法球",
    "422101": "命运法球",
    "422111": "神秘宝珠",
    "422121": "天空法球",
    "422131": "灵魂宝球",
    "422141": "远古法球",
    "422151": "深渊宝珠",
    "422161": "虚空法球",
    "422171": "次元宝珠",
    "422181": "暗影法球",
    "422191": "永恒法球",
    "423011": "魔法宝珠",
    "423021": "长老法球",
    "423031": "辉煌宝球",
    "423041": "冰冻法球",
    "423051": "预言宝珠",
    "423061": "暗黑法球",
    "423071": "符文宝珠",
    "423081": "闪耀法球",
    "423091": "奥术法球",
    "423101": "命运法球",
    "423111": "神秘宝珠",
    "423121": "天空法球",
    "423131": "灵魂宝球",
    "423141": "远古法球",
    "423151": "深渊宝珠",
    "423161": "虚空法球",
    "423171": "次元宝珠",
    "423181": "暗影法球",
    "423191": "永恒法球",
    "424011": "魔法宝珠",
    "424021": "长老法球",
    "424031": "辉煌宝球",
    "424041": "冰冻法球",
    "424051": "预言宝珠",
    "424061": "暗黑法球",
    "424071": "符文宝珠",
    "424081": "闪耀法球",
    "424091": "奥术法球",
    "424101": "命运法球",
    "424111": "神秘宝珠",
    "424121": "天空法球",
    "424131": "灵魂宝球",
    "424141": "远古法球",
    "424151": "深渊宝珠",
    "424161": "虚空法球",
    "424171": "次元宝珠",
    "424181": "暗影法球",
    "424191": "永恒法球",
    "425041": "冰冻法球",
    "425051": "预言宝珠",
    "425061": "暗黑法球",
    "425071": "符文宝珠",
    "425081": "闪耀法球",
    "425091": "奥术法球",
    "425101": "命运法球",
    "425111": "神秘宝珠",
    "425121": "天空法球",
    "425131": "灵魂宝球",
    "425141": "远古法球",
    "425151": "深渊宝珠",
    "425161": "虚空法球",
    "425171": "次元宝珠",
    "425181": "暗影法球",
    "425191": "永恒法球",
    "426061": "暗黑法球",
    "426071": "符文宝珠",
    "426081": "闪耀法球",
    "426091": "奥术法球",
    "426101": "命运法球",
    "426111": "神秘宝珠",
    "426121": "天空法球",
    "426131": "灵魂宝球",
    "426141": "远古法球",
    "426151": "深渊宝珠",
    "426161": "虚空法球",
    "426171": "次元宝珠",
    "426181": "暗影法球",
    "426191": "永恒法球",
    "427081": "闪耀法球",
    "427091": "奥术法球",
    "427101": "命运法球",
    "427111": "神秘宝珠",
    "427121": "天空法球",
    "427131": "灵魂宝球",
    "427141": "远古法球",
    "427151": "深渊宝珠",
    "427161": "虚空法球",
    "427171": "次元宝珠",
    "427181": "暗影法球",
    "427191": "永恒法球",
    "428101": "命运法球",
    "428111": "神秘宝珠",
    "428121": "天空法球",
    "428131": "灵魂宝球",
    "428141": "远古法球",
    "428151": "深渊宝珠",
    "428161": "虚空法球",
    "428171": "次元宝珠",
    "428181": "暗影法球",
    "428191": "永恒法球",
    "429121": "天空法球",
    "429131": "灵魂宝球",
    "429141": "远古法球",
    "429151": "深渊宝珠",
    "429161": "虚空法球",
    "429171": "次元宝珠",
    "429181": "暗影法球",
    "429191": "永恒法球",
    "430001": "祈祷法典",
    "430002": "帝国魔法书",
    "430003": "铁制魔法书",
    "430004": "骑士魔法书",
    "430005": "祝福典籍",
    "430006": "统帅魔法书",
    "430007": "战争魔法书",
    "430008": "皇帝魔典",
    "430009": "符文魔典",
    "430010": "赤红魔法书",
    "430011": "命运法典",
    "430012": "大魔法书",
    "430013": "风暴魔法书",
    "430014": "战士魔法书",
    "430015": "虚空典籍",
    "430016": "水晶魔法书",
    "430017": "次元魔法书",
    "430018": "暗影魔典",
    "430019": "永恒魔典",
    "430020": "天界魔法书",
    "431011": "祈祷法典",
    "431021": "帝国魔法书",
    "431031": "铁制魔法书",
    "431041": "骑士魔法书",
    "431051": "祝福典籍",
    "431061": "统帅魔法书",
    "431071": "战争魔法书",
    "431081": "皇帝魔典",
    "431091": "符文魔典",
    "431101": "赤红魔法书",
    "431111": "命运法典",
    "431121": "大魔法书",
    "431131": "风暴魔法书",
    "431141": "战士魔法书",
    "431151": "虚空典籍",
    "431161": "水晶魔法书",
    "431171": "次元魔法书",
    "431181": "暗影魔典",
    "431191": "永恒魔典",
    "432011": "祈祷法典",
    "432021": "帝国魔法书",
    "432031": "铁制魔法书",
    "432041": "骑士魔法书",
    "432051": "祝福典籍",
    "432061": "统帅魔法书",
    "432071": "战争魔法书",
    "432081": "皇帝魔典",
    "432091": "符文魔典",
    "432101": "赤红魔法书",
    "432111": "命运法典",
    "432121": "大魔法书",
    "432131": "风暴魔法书",
    "432141": "战士魔法书",
    "432151": "虚空典籍",
    "432161": "水晶魔法书",
    "432171": "次元魔法书",
    "432181": "暗影魔典",
    "432191": "永恒魔典",
    "433011": "祈祷法典",
    "433021": "帝国魔法书",
    "433031": "铁制魔法书",
    "433041": "骑士魔法书",
    "433051": "祝福典籍",
    "433061": "统帅魔法书",
    "433071": "战争魔法书",
    "433081": "皇帝魔典",
    "433091": "符文魔典",
    "433101": "赤红魔法书",
    "433111": "命运法典",
    "433121": "大魔法书",
    "433131": "风暴魔法书",
    "433141": "战士魔法书",
    "433151": "虚空典籍",
    "433161": "水晶魔法书",
    "433171": "次元魔法书",
    "433181": "暗影魔典",
    "433191": "永恒魔典",
    "434011": "祈祷法典",
    "434021": "帝国魔法书",
    "434031": "铁制魔法书",
    "434041": "骑士魔法书",
    "434051": "祝福典籍",
    "434061": "统帅魔法书",
    "434071": "战争魔法书",
    "434081": "皇帝魔典",
    "434091": "符文魔典",
    "434101": "赤红魔法书",
    "434111": "命运法典",
    "434121": "大魔法书",
    "434131": "风暴魔法书",
    "434141": "战士魔法书",
    "434151": "虚空典籍",
    "434161": "水晶魔法书",
    "434171": "次元魔法书",
    "434181": "暗影魔典",
    "434191": "永恒魔典",
    "435041": "骑士魔法书",
    "435051": "祝福典籍",
    "435061": "统帅魔法书",
    "435071": "战争魔法书",
    "435081": "皇帝魔典",
    "435091": "符文魔典",
    "435101": "赤红魔法书",
    "435111": "命运法典",
    "435121": "大魔法书",
    "435131": "风暴魔法书",
    "435141": "战士魔法书",
    "435151": "虚空典籍",
    "435161": "水晶魔法书",
    "435171": "次元魔法书",
    "435181": "暗影魔典",
    "435191": "永恒魔典",
    "436061": "统帅魔法书",
    "436071": "战争魔法书",
    "436081": "皇帝魔典",
    "436091": "符文魔典",
    "436101": "赤红魔法书",
    "436111": "命运法典",
    "436121": "大魔法书",
    "436131": "风暴魔法书",
    "436141": "战士魔法书",
    "436151": "虚空典籍",
    "436161": "水晶魔法书",
    "436171": "次元魔法书",
    "436181": "暗影魔典",
    "436191": "永恒魔典",
    "437081": "皇帝魔典",
    "437091": "符文魔典",
    "437101": "赤红魔法书",
    "437111": "命运法典",
    "437121": "大魔法书",
    "437131": "风暴魔法书",
    "437141": "战士魔法书",
    "437151": "虚空典籍",
    "437161": "水晶魔法书",
    "437171": "次元魔法书",
    "437181": "暗影魔典",
    "437191": "永恒魔典",
    "438101": "赤红魔法书",
    "438111": "命运法典",
    "438121": "大魔法书",
    "438131": "风暴魔法书",
    "438141": "战士魔法书",
    "438151": "虚空典籍",
    "438161": "水晶魔法书",
    "438171": "次元魔法书",
    "438181": "暗影魔典",
    "438191": "永恒魔典",
    "439121": "大魔法书",
    "439131": "风暴魔法书",
    "439141": "战士魔法书",
    "439151": "虚空典籍",
    "439161": "水晶魔法书",
    "439171": "次元魔法书",
    "439181": "暗影魔典",
    "439191": "永恒魔典",
    "440001": "短弩箭",
    "440002": "恐惧弩矢",
    "440003": "猎人弩箭",
    "440004": "倒刺弩箭",
    "440005": "野兽弩矢",
    "440006": "迅捷弩箭",
    "440007": "铁制弩箭",
    "440008": "重型弩箭",
    "440009": "符文弩箭",
    "440010": "英雄弩箭",
    "440011": "命运弩箭",
    "440012": "风暴弩矢",
    "440013": "雷霆弩箭",
    "440014": "迅捷弩箭",
    "440015": "虚空弩矢",
    "440016": "毒弩箭",
    "440017": "次元弩箭",
    "440018": "暗影弩箭",
    "440019": "古代弩箭",
    "440020": "神圣弩箭",
    "441011": "短弩箭",
    "441021": "恐惧弩矢",
    "441031": "猎人弩箭",
    "441041": "倒刺弩箭",
    "441051": "野兽弩矢",
    "441061": "迅捷弩箭",
    "441071": "铁制弩箭",
    "441081": "重型弩箭",
    "441091": "符文弩箭",
    "441101": "英雄弩箭",
    "441111": "命运弩箭",
    "441121": "风暴弩矢",
    "441131": "雷霆弩箭",
    "441141": "迅捷弩箭",
    "441151": "虚空弩矢",
    "441161": "毒弩箭",
    "441171": "次元弩箭",
    "441181": "暗影弩箭",
    "441191": "古代弩箭",
    "442011": "短弩箭",
    "442021": "恐惧弩矢",
    "442031": "猎人弩箭",
    "442041": "倒刺弩箭",
    "442051": "野兽弩矢",
    "442061": "迅捷弩箭",
    "442071": "铁制弩箭",
    "442081": "重型弩箭",
    "442091": "符文弩箭",
    "442101": "英雄弩箭",
    "442111": "命运弩箭",
    "442121": "风暴弩矢",
    "442131": "雷霆弩箭",
    "442141": "迅捷弩箭",
    "442151": "虚空弩矢",
    "442161": "毒弩箭",
    "442171": "次元弩箭",
    "442181": "暗影弩箭",
    "442191": "古代弩箭",
    "443011": "短弩箭",
    "443021": "恐惧弩矢",
    "443031": "猎人弩箭",
    "443041": "倒刺弩箭",
    "443051": "野兽弩矢",
    "443061": "迅捷弩箭",
    "443071": "铁制弩箭",
    "443081": "重型弩箭",
    "443091": "符文弩箭",
    "443101": "英雄弩箭",
    "443111": "命运弩箭",
    "443121": "风暴弩矢",
    "443131": "雷霆弩箭",
    "443141": "迅捷弩箭",
    "443151": "虚空弩矢",
    "443161": "毒弩箭",
    "443171": "次元弩箭",
    "443181": "暗影弩箭",
    "443191": "古代弩箭",
    "444011": "短弩箭",
    "444021": "恐惧弩矢",
    "444031": "猎人弩箭",
    "444041": "倒刺弩箭",
    "444051": "野兽弩矢",
    "444061": "迅捷弩箭",
    "444071": "铁制弩箭",
    "444081": "重型弩箭",
    "444091": "符文弩箭",
    "444101": "英雄弩箭",
    "444111": "命运弩箭",
    "444121": "风暴弩矢",
    "444131": "雷霆弩箭",
    "444141": "迅捷弩箭",
    "444151": "虚空弩矢",
    "444161": "毒弩箭",
    "444171": "次元弩箭",
    "444181": "暗影弩箭",
    "444191": "古代弩箭",
    "445041": "倒刺弩箭",
    "445051": "野兽弩矢",
    "445061": "迅捷弩箭",
    "445071": "铁制弩箭",
    "445081": "重型弩箭",
    "445091": "符文弩箭",
    "445101": "英雄弩箭",
    "445111": "命运弩箭",
    "445121": "风暴弩矢",
    "445131": "雷霆弩箭",
    "445141": "迅捷弩箭",
    "445151": "虚空弩矢",
    "445161": "毒弩箭",
    "445171": "次元弩箭",
    "445181": "暗影弩箭",
    "445191": "古代弩箭",
    "446061": "迅捷弩箭",
    "446071": "铁制弩箭",
    "446081": "重型弩箭",
    "446091": "符文弩箭",
    "446101": "英雄弩箭",
    "446111": "命运弩箭",
    "446121": "风暴弩矢",
    "446131": "雷霆弩箭",
    "446141": "迅捷弩箭",
    "446151": "虚空弩矢",
    "446161": "毒弩箭",
    "446171": "次元弩箭",
    "446181": "暗影弩箭",
    "446191": "古代弩箭",
    "447081": "重型弩箭",
    "447091": "符文弩箭",
    "447101": "英雄弩箭",
    "447111": "命运弩箭",
    "447121": "风暴弩矢",
    "447131": "雷霆弩箭",
    "447141": "迅捷弩箭",
    "447151": "虚空弩矢",
    "447161": "毒弩箭",
    "447171": "次元弩箭",
    "447181": "暗影弩箭",
    "447191": "古代弩箭",
    "448101": "英雄弩箭",
    "448111": "命运弩箭",
    "448121": "风暴弩矢",
    "448131": "雷霆弩箭",
    "448141": "迅捷弩箭",
    "448151": "虚空弩矢",
    "448161": "毒弩箭",
    "448171": "次元弩箭",
    "448181": "暗影弩箭",
    "448191": "古代弩箭",
    "449121": "风暴弩矢",
    "449131": "雷霆弩箭",
    "449141": "迅捷弩箭",
    "449151": "虚空弩矢",
    "449161": "毒弩箭",
    "449171": "次元弩箭",
    "449181": "暗影弩箭",
    "449191": "古代弩箭",
    "450001": "短手斧",
    "450002": "皮革手斧",
    "450003": "长柄手斧",
    "450004": "钢铁手斧",
    "450005": "战用手斧",
    "450006": "复合手斧",
    "450007": "战斗手斧",
    "450008": "羽翼手斧",
    "450009": "精英手斧",
    "450010": "大手斧",
    "450011": "神秘手斧",
    "450012": "迅捷手斧",
    "450013": "远古手斧",
    "450014": "无限手斧",
    "450015": "混沌手斧",
    "450016": "力量手斧",
    "450017": "次元手斧",
    "450018": "暗影手斧",
    "450019": "永恒手斧",
    "450020": "崇高手斧",
    "451011": "短手斧",
    "451021": "皮革手斧",
    "451031": "长柄手斧",
    "451041": "钢铁手斧",
    "451051": "战用手斧",
    "451061": "复合手斧",
    "451071": "战斗手斧",
    "451081": "羽翼手斧",
    "451091": "精英手斧",
    "451101": "大手斧",
    "451111": "神秘手斧",
    "451121": "迅捷手斧",
    "451131": "远古手斧",
    "451141": "无限手斧",
    "451151": "混沌手斧",
    "451161": "力量手斧",
    "451171": "次元手斧",
    "451181": "暗影手斧",
    "451191": "永恒手斧",
    "452011": "短手斧",
    "452021": "皮革手斧",
    "452031": "长柄手斧",
    "452041": "钢铁手斧",
    "452051": "战用手斧",
    "452061": "复合手斧",
    "452071": "战斗手斧",
    "452081": "羽翼手斧",
    "452091": "精英手斧",
    "452101": "大手斧",
    "452111": "神秘手斧",
    "452121": "迅捷手斧",
    "452131": "远古手斧",
    "452141": "无限手斧",
    "452151": "混沌手斧",
    "452161": "力量手斧",
    "452171": "次元手斧",
    "452181": "暗影手斧",
    "452191": "永恒手斧",
    "453011": "短手斧",
    "453021": "皮革手斧",
    "453031": "长柄手斧",
    "453041": "钢铁手斧",
    "453051": "战用手斧",
    "453061": "复合手斧",
    "453071": "战斗手斧",
    "453081": "羽翼手斧",
    "453091": "精英手斧",
    "453101": "大手斧",
    "453111": "神秘手斧",
    "453121": "迅捷手斧",
    "453131": "远古手斧",
    "453141": "无限手斧",
    "453151": "混沌手斧",
    "453161": "力量手斧",
    "453171": "次元手斧",
    "453181": "暗影手斧",
    "453191": "永恒手斧",
    "454011": "短手斧",
    "454021": "皮革手斧",
    "454031": "长柄手斧",
    "454041": "钢铁手斧",
    "454051": "战用手斧",
    "454061": "复合手斧",
    "454071": "战斗手斧",
    "454081": "羽翼手斧",
    "454091": "精英手斧",
    "454101": "大手斧",
    "454111": "神秘手斧",
    "454121": "迅捷手斧",
    "454131": "远古手斧",
    "454141": "无限手斧",
    "454151": "混沌手斧",
    "454161": "力量手斧",
    "454171": "次元手斧",
    "454181": "暗影手斧",
    "454191": "永恒手斧",
    "455041": "钢铁手斧",
    "455051": "战用手斧",
    "455061": "复合手斧",
    "455071": "战斗手斧",
    "455081": "羽翼手斧",
    "455091": "精英手斧",
    "455101": "大手斧",
    "455111": "神秘手斧",
    "455121": "迅捷手斧",
    "455131": "远古手斧",
    "455141": "无限手斧",
    "455151": "混沌手斧",
    "455161": "力量手斧",
    "455171": "次元手斧",
    "455181": "暗影手斧",
    "455191": "永恒手斧",
    "456061": "复合手斧",
    "456071": "战斗手斧",
    "456081": "羽翼手斧",
    "456091": "精英手斧",
    "456101": "大手斧",
    "456111": "神秘手斧",
    "456121": "迅捷手斧",
    "456131": "远古手斧",
    "456141": "无限手斧",
    "456151": "混沌手斧",
    "456161": "力量手斧",
    "456171": "次元手斧",
    "456181": "暗影手斧",
    "456191": "永恒手斧",
    "457081": "羽翼手斧",
    "457091": "精英手斧",
    "457101": "大手斧",
    "457111": "神秘手斧",
    "457121": "迅捷手斧",
    "457131": "远古手斧",
    "457141": "无限手斧",
    "457151": "混沌手斧",
    "457161": "力量手斧",
    "457171": "次元手斧",
    "457181": "暗影手斧",
    "457191": "永恒手斧",
    "458101": "大手斧",
    "458111": "神秘手斧",
    "458121": "迅捷手斧",
    "458131": "远古手斧",
    "458141": "无限手斧",
    "458151": "混沌手斧",
    "458161": "力量手斧",
    "458171": "次元手斧",
    "458181": "暗影手斧",
    "458191": "永恒手斧",
    "459121": "迅捷手斧",
    "459131": "远古手斧",
    "459141": "无限手斧",
    "459151": "混沌手斧",
    "459161": "力量手斧",
    "459171": "次元手斧",
    "459181": "暗影手斧",
    "459191": "永恒手斧",
    "500001": "木制头盔",
    "500002": "帝国头盔",
    "500003": "铁制头盔",
    "500004": "骑士头盔",
    "500005": "锁链头盔",
    "500006": "中级头盔",
    "500007": "战争头盔",
    "500008": "皇帝头盔",
    "500009": "符文头盔",
    "500010": "红色头盔",
    "500011": "命运头盔",
    "500012": "大头盔",
    "500013": "风暴头盔",
    "500014": "战士头盔",
    "500015": "虚空头盔",
    "500016": "水晶头盔",
    "500017": "次元头盔",
    "500018": "暗影头盔",
    "500019": "永恒头盔",
    "500020": "辉耀头盔",
    "501011": "木制头盔",
    "501021": "帝国头盔",
    "501031": "铁制头盔",
    "501041": "骑士头盔",
    "501051": "锁链头盔",
    "501061": "中级头盔",
    "501071": "战争头盔",
    "501081": "皇帝头盔",
    "501091": "符文头盔",
    "501101": "红色头盔",
    "501111": "命运头盔",
    "501121": "大头盔",
    "501131": "风暴头盔",
    "501141": "战士头盔",
    "501151": "虚空头盔",
    "501161": "水晶头盔",
    "501171": "次元头盔",
    "501181": "暗影头盔",
    "501191": "永恒头盔",
    "502011": "木制头盔",
    "502021": "帝国头盔",
    "502031": "铁制头盔",
    "502041": "骑士头盔",
    "502051": "锁链头盔",
    "502061": "中级头盔",
    "502071": "战争头盔",
    "502081": "皇帝头盔",
    "502091": "符文头盔",
    "502101": "红色头盔",
    "502111": "命运头盔",
    "502121": "大头盔",
    "502131": "风暴头盔",
    "502141": "战士头盔",
    "502151": "虚空头盔",
    "502161": "水晶头盔",
    "502171": "次元头盔",
    "502181": "暗影头盔",
    "502191": "永恒头盔",
    "503011": "木制头盔",
    "503021": "帝国头盔",
    "503031": "铁制头盔",
    "503041": "骑士头盔",
    "503051": "锁链头盔",
    "503061": "中级头盔",
    "503071": "战争头盔",
    "503081": "皇帝头盔",
    "503091": "符文头盔",
    "503101": "红色头盔",
    "503111": "命运头盔",
    "503121": "大头盔",
    "503131": "风暴头盔",
    "503141": "战士头盔",
    "503151": "虚空头盔",
    "503161": "水晶头盔",
    "503171": "次元头盔",
    "503181": "暗影头盔",
    "503191": "永恒头盔",
    "504011": "木制头盔",
    "504021": "帝国头盔",
    "504031": "铁制头盔",
    "504041": "骑士头盔",
    "504051": "锁链头盔",
    "504061": "中级头盔",
    "504071": "战争头盔",
    "504081": "皇帝头盔",
    "504091": "符文头盔",
    "504101": "红色头盔",
    "504111": "命运头盔",
    "504121": "大头盔",
    "504131": "风暴头盔",
    "504141": "战士头盔",
    "504151": "虚空头盔",
    "504161": "水晶头盔",
    "504171": "次元头盔",
    "504181": "暗影头盔",
    "504191": "永恒头盔",
    "505041": "骑士头盔",
    "505051": "锁链头盔",
    "505061": "中级头盔",
    "505071": "战争头盔",
    "505081": "皇帝头盔",
    "505091": "符文头盔",
    "505101": "红色头盔",
    "505111": "命运头盔",
    "505121": "大头盔",
    "505131": "风暴头盔",
    "505141": "战士头盔",
    "505151": "虚空头盔",
    "505161": "水晶头盔",
    "505171": "次元头盔",
    "505181": "暗影头盔",
    "505191": "永恒头盔",
    "506061": "中级头盔",
    "506071": "战争头盔",
    "506081": "皇帝头盔",
    "506091": "符文头盔",
    "506101": "红色头盔",
    "506111": "命运头盔",
    "506121": "大头盔",
    "506131": "风暴头盔",
    "506141": "战士头盔",
    "506151": "虚空头盔",
    "506161": "水晶头盔",
    "506171": "次元头盔",
    "506181": "暗影头盔",
    "506191": "永恒头盔",
    "507081": "皇帝头盔",
    "507091": "符文头盔",
    "507101": "红色头盔",
    "507111": "命运头盔",
    "507121": "大头盔",
    "507131": "风暴头盔",
    "507141": "战士头盔",
    "507151": "虚空头盔",
    "507161": "水晶头盔",
    "507171": "次元头盔",
    "507181": "暗影头盔",
    "507191": "永恒头盔",
    "508101": "红色头盔",
    "508111": "命运头盔",
    "508121": "大头盔",
    "508131": "风暴头盔",
    "508141": "战士头盔",
    "508151": "虚空头盔",
    "508161": "水晶头盔",
    "508171": "次元头盔",
    "508181": "暗影头盔",
    "508191": "永恒头盔",
    "509121": "大头盔",
    "509131": "风暴头盔",
    "509141": "战士头盔",
    "509151": "虚空头盔",
    "509161": "水晶头盔",
    "509171": "次元头盔",
    "509181": "暗影头盔",
    "509191": "永恒头盔",
    "510001": "木制盔甲",
    "510002": "帝国铠甲",
    "510003": "铁板甲",
    "510004": "锁子甲",
    "510005": "骑士铠甲",
    "510006": "命运铠甲",
    "510007": "战争铠甲",
    "510008": "重甲",
    "510009": "符文板甲",
    "510010": "龙鳞铠甲",
    "510011": "神秘盔甲",
    "510012": "大铠甲",
    "510013": "远古铠甲",
    "510014": "闪光铠甲",
    "510015": "虚空铠甲",
    "510016": "龙鳞铠甲",
    "510017": "次元铠甲",
    "510018": "暗影铠甲",
    "510019": "永恒护甲",
    "510020": "辉耀铠甲",
    "511011": "木制盔甲",
    "511021": "帝国铠甲",
    "511031": "铁板甲",
    "511041": "锁子甲",
    "511051": "骑士铠甲",
    "511061": "命运铠甲",
    "511071": "战争铠甲",
    "511081": "重甲",
    "511091": "符文板甲",
    "511101": "龙鳞铠甲",
    "511111": "神秘盔甲",
    "511121": "大铠甲",
    "511131": "远古铠甲",
    "511141": "闪光铠甲",
    "511151": "虚空铠甲",
    "511161": "龙鳞铠甲",
    "511171": "次元铠甲",
    "511181": "暗影铠甲",
    "511191": "永恒护甲",
    "512011": "木制盔甲",
    "512021": "帝国铠甲",
    "512031": "铁板甲",
    "512041": "锁子甲",
    "512051": "骑士铠甲",
    "512061": "命运铠甲",
    "512071": "战争铠甲",
    "512081": "重甲",
    "512091": "符文板甲",
    "512101": "龙鳞铠甲",
    "512111": "神秘盔甲",
    "512121": "大铠甲",
    "512131": "远古铠甲",
    "512141": "闪光铠甲",
    "512151": "虚空铠甲",
    "512161": "龙鳞铠甲",
    "512171": "次元铠甲",
    "512181": "暗影铠甲",
    "512191": "永恒护甲",
    "513011": "木制盔甲",
    "513021": "帝国铠甲",
    "513031": "铁板甲",
    "513041": "锁子甲",
    "513051": "骑士铠甲",
    "513061": "命运铠甲",
    "513071": "战争铠甲",
    "513081": "重甲",
    "513091": "符文板甲",
    "513101": "龙鳞铠甲",
    "513111": "神秘盔甲",
    "513121": "大铠甲",
    "513131": "远古铠甲",
    "513141": "闪光铠甲",
    "513151": "虚空铠甲",
    "513161": "龙鳞铠甲",
    "513171": "次元铠甲",
    "513181": "暗影铠甲",
    "513191": "永恒护甲",
    "514011": "木制盔甲",
    "514021": "帝国铠甲",
    "514031": "铁板甲",
    "514041": "锁子甲",
    "514051": "骑士铠甲",
    "514061": "命运铠甲",
    "514071": "战争铠甲",
    "514081": "重甲",
    "514091": "符文板甲",
    "514101": "龙鳞铠甲",
    "514111": "神秘盔甲",
    "514121": "大铠甲",
    "514131": "远古铠甲",
    "514141": "闪光铠甲",
    "514151": "虚空铠甲",
    "514161": "龙鳞铠甲",
    "514171": "次元铠甲",
    "514181": "暗影铠甲",
    "514191": "永恒护甲",
    "515041": "锁子甲",
    "515051": "骑士铠甲",
    "515061": "命运铠甲",
    "515071": "战争铠甲",
    "515081": "重甲",
    "515091": "符文板甲",
    "515101": "龙鳞铠甲",
    "515111": "神秘盔甲",
    "515121": "大铠甲",
    "515131": "远古铠甲",
    "515141": "闪光铠甲",
    "515151": "虚空铠甲",
    "515161": "龙鳞铠甲",
    "515171": "次元铠甲",
    "515181": "暗影铠甲",
    "515191": "永恒护甲",
    "516061": "命运铠甲",
    "516071": "战争铠甲",
    "516081": "重甲",
    "516091": "符文板甲",
    "516101": "龙鳞铠甲",
    "516111": "神秘盔甲",
    "516121": "大铠甲",
    "516131": "远古铠甲",
    "516141": "闪光铠甲",
    "516151": "虚空铠甲",
    "516161": "龙鳞铠甲",
    "516171": "次元铠甲",
    "516181": "暗影铠甲",
    "516191": "永恒护甲",
    "517081": "重甲",
    "517091": "符文板甲",
    "517101": "龙鳞铠甲",
    "517111": "神秘盔甲",
    "517121": "大铠甲",
    "517131": "远古铠甲",
    "517141": "闪光铠甲",
    "517151": "虚空铠甲",
    "517161": "龙鳞铠甲",
    "517171": "次元铠甲",
    "517181": "暗影铠甲",
    "517191": "永恒护甲",
    "518101": "龙鳞铠甲",
    "518111": "神秘盔甲",
    "518121": "大铠甲",
    "518131": "远古铠甲",
    "518141": "闪光铠甲",
    "518151": "虚空铠甲",
    "518161": "龙鳞铠甲",
    "518171": "次元铠甲",
    "518181": "暗影铠甲",
    "518191": "永恒护甲",
    "519121": "大铠甲",
    "519131": "远古铠甲",
    "519141": "闪光铠甲",
    "519151": "虚空铠甲",
    "519161": "龙鳞铠甲",
    "519171": "次元铠甲",
    "519181": "暗影铠甲",
    "519191": "永恒护甲",
    "520001": "皮革手套",
    "520002": "帝国手套",
    "520003": "铁制手套",
    "520004": "骑士手套",
    "520005": "锁链手套",
    "520006": "命运手套",
    "520007": "战争手套",
    "520008": "重型手套",
    "520009": "符文手套",
    "520010": "板甲手套",
    "520011": "神秘手套",
    "520012": "大手套",
    "520013": "远古手套",
    "520014": "闪光手套",
    "520015": "虚空手套",
    "520016": "龙鳞手套",
    "520017": "次元手套",
    "520018": "暗影手套",
    "520019": "永恒手套",
    "520020": "辉耀手套",
    "521011": "皮革手套",
    "521021": "帝国手套",
    "521031": "铁制手套",
    "521041": "骑士手套",
    "521051": "锁链手套",
    "521061": "命运手套",
    "521071": "战争手套",
    "521081": "重型手套",
    "521091": "符文手套",
    "521101": "板甲手套",
    "521111": "神秘手套",
    "521121": "大手套",
    "521131": "远古手套",
    "521141": "闪光手套",
    "521151": "虚空手套",
    "521161": "龙鳞手套",
    "521171": "次元手套",
    "521181": "暗影手套",
    "521191": "永恒手套",
    "522011": "皮革手套",
    "522021": "帝国手套",
    "522031": "铁制手套",
    "522041": "骑士手套",
    "522051": "锁链手套",
    "522061": "命运手套",
    "522071": "战争手套",
    "522081": "重型手套",
    "522091": "符文手套",
    "522101": "板甲手套",
    "522111": "神秘手套",
    "522121": "大手套",
    "522131": "远古手套",
    "522141": "闪光手套",
    "522151": "虚空手套",
    "522161": "龙鳞手套",
    "522171": "次元手套",
    "522181": "暗影手套",
    "522191": "永恒手套",
    "523011": "皮革手套",
    "523021": "帝国手套",
    "523031": "铁制手套",
    "523041": "骑士手套",
    "523051": "锁链手套",
    "523061": "命运手套",
    "523071": "战争手套",
    "523081": "重型手套",
    "523091": "符文手套",
    "523101": "板甲手套",
    "523111": "神秘手套",
    "523121": "大手套",
    "523131": "远古手套",
    "523141": "闪光手套",
    "523151": "虚空手套",
    "523161": "龙鳞手套",
    "523171": "次元手套",
    "523181": "暗影手套",
    "523191": "永恒手套",
    "524011": "皮革手套",
    "524021": "帝国手套",
    "524031": "铁制手套",
    "524041": "骑士手套",
    "524051": "锁链手套",
    "524061": "命运手套",
    "524071": "战争手套",
    "524081": "重型手套",
    "524091": "符文手套",
    "524101": "板甲手套",
    "524111": "神秘手套",
    "524121": "大手套",
    "524131": "远古手套",
    "524141": "闪光手套",
    "524151": "虚空手套",
    "524161": "龙鳞手套",
    "524171": "次元手套",
    "524181": "暗影手套",
    "524191": "永恒手套",
    "525041": "骑士手套",
    "525051": "锁链手套",
    "525061": "命运手套",
    "525071": "战争手套",
    "525081": "重型手套",
    "525091": "符文手套",
    "525101": "板甲手套",
    "525111": "神秘手套",
    "525121": "大手套",
    "525131": "远古手套",
    "525141": "闪光手套",
    "525151": "虚空手套",
    "525161": "龙鳞手套",
    "525171": "次元手套",
    "525181": "暗影手套",
    "525191": "永恒手套",
    "526061": "命运手套",
    "526071": "战争手套",
    "526081": "重型手套",
    "526091": "符文手套",
    "526101": "板甲手套",
    "526111": "神秘手套",
    "526121": "大手套",
    "526131": "远古手套",
    "526141": "闪光手套",
    "526151": "虚空手套",
    "526161": "龙鳞手套",
    "526171": "次元手套",
    "526181": "暗影手套",
    "526191": "永恒手套",
    "527081": "重型手套",
    "527091": "符文手套",
    "527101": "板甲手套",
    "527111": "神秘手套",
    "527121": "大手套",
    "527131": "远古手套",
    "527141": "闪光手套",
    "527151": "虚空手套",
    "527161": "龙鳞手套",
    "527171": "次元手套",
    "527181": "暗影手套",
    "527191": "永恒手套",
    "528101": "板甲手套",
    "528111": "神秘手套",
    "528121": "大手套",
    "528131": "远古手套",
    "528141": "闪光手套",
    "528151": "虚空手套",
    "528161": "龙鳞手套",
    "528171": "次元手套",
    "528181": "暗影手套",
    "528191": "永恒手套",
    "529121": "大手套",
    "529131": "远古手套",
    "529141": "闪光手套",
    "529151": "虚空手套",
    "529161": "龙鳞手套",
    "529171": "次元手套",
    "529181": "暗影手套",
    "529191": "永恒手套",
    "530001": "木制靴子",
    "530002": "帝国靴子",
    "530003": "铁制靴子",
    "530004": "骑士靴",
    "530005": "锁链靴",
    "530006": "命运靴子",
    "530007": "战争靴",
    "530008": "重型靴子",
    "530009": "符文靴",
    "530010": "板甲靴子",
    "530011": "神秘靴子",
    "530012": "大靴子",
    "530013": "远古靴子",
    "530014": "闪光靴",
    "530015": "虚空靴",
    "530016": "水晶靴子",
    "530017": "次元靴",
    "530018": "暗影靴子",
    "530019": "永恒靴",
    "530020": "辉耀靴子",
    "531011": "木制靴子",
    "531021": "帝国靴子",
    "531031": "铁制靴子",
    "531041": "骑士靴",
    "531051": "锁链靴",
    "531061": "命运靴子",
    "531071": "战争靴",
    "531081": "重型靴子",
    "531091": "符文靴",
    "531101": "板甲靴子",
    "531111": "神秘靴子",
    "531121": "大靴子",
    "531131": "远古靴子",
    "531141": "闪光靴",
    "531151": "虚空靴",
    "531161": "水晶靴子",
    "531171": "次元靴",
    "531181": "暗影靴子",
    "531191": "永恒靴",
    "532011": "木制靴子",
    "532021": "帝国靴子",
    "532031": "铁制靴子",
    "532041": "骑士靴",
    "532051": "锁链靴",
    "532061": "命运靴子",
    "532071": "战争靴",
    "532081": "重型靴子",
    "532091": "符文靴",
    "532101": "板甲靴子",
    "532111": "神秘靴子",
    "532121": "大靴子",
    "532131": "远古靴子",
    "532141": "闪光靴",
    "532151": "虚空靴",
    "532161": "水晶靴子",
    "532171": "次元靴",
    "532181": "暗影靴子",
    "532191": "永恒靴",
    "533011": "木制靴子",
    "533021": "帝国靴子",
    "533031": "铁制靴子",
    "533041": "骑士靴",
    "533051": "锁链靴",
    "533061": "命运靴子",
    "533071": "战争靴",
    "533081": "重型靴子",
    "533091": "符文靴",
    "533101": "板甲靴子",
    "533111": "神秘靴子",
    "533121": "大靴子",
    "533131": "远古靴子",
    "533141": "闪光靴",
    "533151": "虚空靴",
    "533161": "水晶靴子",
    "533171": "次元靴",
    "533181": "暗影靴子",
    "533191": "永恒靴",
    "534011": "木制靴子",
    "534021": "帝国靴子",
    "534031": "铁制靴子",
    "534041": "骑士靴",
    "534051": "锁链靴",
    "534061": "命运靴子",
    "534071": "战争靴",
    "534081": "重型靴子",
    "534091": "符文靴",
    "534101": "板甲靴子",
    "534111": "神秘靴子",
    "534121": "大靴子",
    "534131": "远古靴子",
    "534141": "闪光靴",
    "534151": "虚空靴",
    "534161": "水晶靴子",
    "534171": "次元靴",
    "534181": "暗影靴子",
    "534191": "永恒靴",
    "535041": "骑士靴",
    "535051": "锁链靴",
    "535061": "命运靴子",
    "535071": "战争靴",
    "535081": "重型靴子",
    "535091": "符文靴",
    "535101": "板甲靴子",
    "535111": "神秘靴子",
    "535121": "大靴子",
    "535131": "远古靴子",
    "535141": "闪光靴",
    "535151": "虚空靴",
    "535161": "水晶靴子",
    "535171": "次元靴",
    "535181": "暗影靴子",
    "535191": "永恒靴",
    "536061": "命运靴子",
    "536071": "战争靴",
    "536081": "重型靴子",
    "536091": "符文靴",
    "536101": "板甲靴子",
    "536111": "神秘靴子",
    "536121": "大靴子",
    "536131": "远古靴子",
    "536141": "闪光靴",
    "536151": "虚空靴",
    "536161": "水晶靴子",
    "536171": "次元靴",
    "536181": "暗影靴子",
    "536191": "永恒靴",
    "537081": "重型靴子",
    "537091": "符文靴",
    "537101": "板甲靴子",
    "537111": "神秘靴子",
    "537121": "大靴子",
    "537131": "远古靴子",
    "537141": "闪光靴",
    "537151": "虚空靴",
    "537161": "水晶靴子",
    "537171": "次元靴",
    "537181": "暗影靴子",
    "537191": "永恒靴",
    "538101": "板甲靴子",
    "538111": "神秘靴子",
    "538121": "大靴子",
    "538131": "远古靴子",
    "538141": "闪光靴",
    "538151": "虚空靴",
    "538161": "水晶靴子",
    "538171": "次元靴",
    "538181": "暗影靴子",
    "538191": "永恒靴",
    "539121": "大靴子",
    "539131": "远古靴子",
    "539141": "闪光靴",
    "539151": "虚空靴",
    "539161": "水晶靴子",
    "539171": "次元靴",
    "539181": "暗影靴子",
    "539191": "永恒靴",
    "601011": "铜制护符",
    "601021": "青铜护符",
    "601031": "银制护符",
    "601041": "黄金护身符",
    "601051": "白金护符",
    "601061": "水晶护符",
    "601071": "月光石吊坠",
    "601081": "琥珀吊坠",
    "601091": "红宝石吊坠",
    "601101": "紫水晶项坠",
    "601111": "翡翠护符",
    "601121": "钻石护符",
    "601131": "星尘护符",
    "601141": "日食护身符",
    "601151": "天界护符",
    "601161": "星界护符",
    "601171": "以太护符",
    "601181": "虚空护符",
    "601191": "深渊护符",
    "602011": "铜制护符",
    "602021": "青铜护符",
    "602031": "银制护符",
    "602041": "黄金护身符",
    "602051": "白金护符",
    "602061": "水晶护符",
    "602071": "月光石吊坠",
    "602081": "琥珀吊坠",
    "602091": "红宝石吊坠",
    "602101": "紫水晶项坠",
    "602111": "翡翠护符",
    "602121": "钻石护符",
    "602131": "星尘护符",
    "602141": "日食护身符",
    "602151": "天界护符",
    "602161": "星界护符",
    "602171": "以太护符",
    "602181": "虚空护符",
    "602191": "深渊护符",
    "603011": "铜制护符",
    "603021": "青铜护符",
    "603031": "银制护符",
    "603041": "黄金护身符",
    "603051": "白金护符",
    "603061": "水晶护符",
    "603071": "月光石吊坠",
    "603081": "琥珀吊坠",
    "603091": "红宝石吊坠",
    "603101": "紫水晶项坠",
    "603111": "翡翠护符",
    "603121": "钻石护符",
    "603131": "星尘护符",
    "603141": "日食护身符",
    "603151": "天界护符",
    "603161": "星界护符",
    "603171": "以太护符",
    "603181": "虚空护符",
    "603191": "深渊护符",
    "604011": "铜制护符",
    "604021": "青铜护符",
    "604031": "银制护符",
    "604041": "黄金护身符",
    "604051": "白金护符",
    "604061": "水晶护符",
    "604071": "月光石吊坠",
    "604081": "琥珀吊坠",
    "604091": "红宝石吊坠",
    "604101": "紫水晶项坠",
    "604111": "翡翠护符",
    "604121": "钻石护符",
    "604131": "星尘护符",
    "604141": "日食护身符",
    "604151": "天界护符",
    "604161": "星界护符",
    "604171": "以太护符",
    "604181": "虚空护符",
    "604191": "深渊护符",
    "605041": "黄金护身符",
    "605051": "白金护符",
    "605061": "水晶护符",
    "605071": "月光石吊坠",
    "605081": "琥珀吊坠",
    "605091": "红宝石吊坠",
    "605101": "紫水晶项坠",
    "605111": "翡翠护符",
    "605121": "钻石护符",
    "605131": "星尘护符",
    "605141": "日食护身符",
    "605151": "天界护符",
    "605161": "星界护符",
    "605171": "以太护符",
    "605181": "虚空护符",
    "605191": "深渊护符",
    "606061": "水晶护符",
    "606071": "月光石吊坠",
    "606081": "琥珀吊坠",
    "606091": "红宝石吊坠",
    "606101": "紫水晶项坠",
    "606111": "翡翠护符",
    "606121": "钻石护符",
    "606131": "星尘护符",
    "606141": "日食护身符",
    "606151": "天界护符",
    "606161": "星界护符",
    "606171": "以太护符",
    "606181": "虚空护符",
    "606191": "深渊护符",
    "607081": "琥珀吊坠",
    "607091": "红宝石吊坠",
    "607101": "紫水晶项坠",
    "607111": "翡翠护符",
    "607121": "钻石护符",
    "607131": "星尘护符",
    "607141": "日食护身符",
    "607151": "天界护符",
    "607161": "星界护符",
    "607171": "以太护符",
    "607181": "虚空护符",
    "607191": "深渊护符",
    "608101": "紫水晶项坠",
    "608111": "翡翠护符",
    "608121": "钻石护符",
    "608131": "星尘护符",
    "608141": "日食护身符",
    "608151": "天界护符",
    "608161": "星界护符",
    "608171": "以太护符",
    "608181": "虚空护符",
    "608191": "深渊护符",
    "609121": "钻石护符",
    "609131": "星尘护符",
    "609141": "日食护身符",
    "609151": "天界护符",
    "609161": "星界护符",
    "609171": "以太护符",
    "609181": "虚空护符",
    "609191": "深渊护符",
    "611011": "铜耳环",
    "611021": "青铜耳环",
    "611031": "银耳环",
    "611041": "黄金耳环",
    "611051": "白金耳环",
    "611061": "水晶耳环",
    "611071": "祖母绿耳环",
    "611081": "翡翠耳环",
    "611091": "虎眼耳环",
    "611101": "石榴石耳环",
    "611111": "蓝宝石耳环",
    "611121": "钻石耳环",
    "611131": "月长石耳环",
    "611141": "天界耳环",
    "611151": "日食耳环",
    "611161": "星界耳环",
    "611171": "虚灵耳环",
    "611181": "虚空耳环",
    "611191": "深渊耳环",
    "612011": "铜耳环",
    "612021": "青铜耳环",
    "612031": "银耳环",
    "612041": "黄金耳环",
    "612051": "白金耳环",
    "612061": "水晶耳环",
    "612071": "祖母绿耳环",
    "612081": "翡翠耳环",
    "612091": "虎眼耳环",
    "612101": "石榴石耳环",
    "612111": "蓝宝石耳环",
    "612121": "钻石耳环",
    "612131": "月长石耳环",
    "612141": "天界耳环",
    "612151": "日食耳环",
    "612161": "星界耳环",
    "612171": "虚灵耳环",
    "612181": "虚空耳环",
    "612191": "深渊耳环",
    "613011": "铜耳环",
    "613021": "青铜耳环",
    "613031": "银耳环",
    "613041": "黄金耳环",
    "613051": "白金耳环",
    "613061": "水晶耳环",
    "613071": "祖母绿耳环",
    "613081": "翡翠耳环",
    "613091": "虎眼耳环",
    "613101": "石榴石耳环",
    "613111": "蓝宝石耳环",
    "613121": "钻石耳环",
    "613131": "月长石耳环",
    "613141": "天界耳环",
    "613151": "日食耳环",
    "613161": "星界耳环",
    "613171": "虚灵耳环",
    "613181": "虚空耳环",
    "613191": "深渊耳环",
    "614011": "铜耳环",
    "614021": "青铜耳环",
    "614031": "银耳环",
    "614041": "黄金耳环",
    "614051": "白金耳环",
    "614061": "水晶耳环",
    "614071": "祖母绿耳环",
    "614081": "翡翠耳环",
    "614091": "虎眼耳环",
    "614101": "石榴石耳环",
    "614111": "蓝宝石耳环",
    "614121": "钻石耳环",
    "614131": "月长石耳环",
    "614141": "天界耳环",
    "614151": "日食耳环",
    "614161": "星界耳环",
    "614171": "虚灵耳环",
    "614181": "虚空耳环",
    "614191": "深渊耳环",
    "615041": "黄金耳环",
    "615051": "白金耳环",
    "615061": "水晶耳环",
    "615071": "祖母绿耳环",
    "615081": "翡翠耳环",
    "615091": "虎眼耳环",
    "615101": "石榴石耳环",
    "615111": "蓝宝石耳环",
    "615121": "钻石耳环",
    "615131": "月长石耳环",
    "615141": "天界耳环",
    "615151": "日食耳环",
    "615161": "星界耳环",
    "615171": "虚灵耳环",
    "615181": "虚空耳环",
    "615191": "深渊耳环",
    "616061": "水晶耳环",
    "616071": "祖母绿耳环",
    "616081": "翡翠耳环",
    "616091": "虎眼耳环",
    "616101": "石榴石耳环",
    "616111": "蓝宝石耳环",
    "616121": "钻石耳环",
    "616131": "月长石耳环",
    "616141": "天界耳环",
    "616151": "日食耳环",
    "616161": "星界耳环",
    "616171": "虚灵耳环",
    "616181": "虚空耳环",
    "616191": "深渊耳环",
    "617081": "翡翠耳环",
    "617091": "虎眼耳环",
    "617101": "石榴石耳环",
    "617111": "蓝宝石耳环",
    "617121": "钻石耳环",
    "617131": "月长石耳环",
    "617141": "天界耳环",
    "617151": "日食耳环",
    "617161": "星界耳环",
    "617171": "虚灵耳环",
    "617181": "虚空耳环",
    "617191": "深渊耳环",
    "618101": "石榴石耳环",
    "618111": "蓝宝石耳环",
    "618121": "钻石耳环",
    "618131": "月长石耳环",
    "618141": "天界耳环",
    "618151": "日食耳环",
    "618161": "星界耳环",
    "618171": "虚灵耳环",
    "618181": "虚空耳环",
    "618191": "深渊耳环",
    "619121": "钻石耳环",
    "619131": "月长石耳环",
    "619141": "天界耳环",
    "619151": "日食耳环",
    "619161": "星界耳环",
    "619171": "虚灵耳环",
    "619181": "虚空耳环",
    "619191": "深渊耳环",
    "621011": "铜戒指",
    "621021": "青铜戒指",
    "621031": "银戒指",
    "621041": "金戒指",
    "621051": "铂金戒指",
    "621061": "水晶戒指",
    "621071": "琥珀戒指",
    "621081": "黄玉戒指",
    "621091": "紫水晶戒指",
    "621101": "石榴石戒指",
    "621111": "翡翠戒指",
    "621121": "钻石戒指",
    "621131": "月长石戒指",
    "621141": "蚀月戒指",
    "621151": "天界戒指",
    "621161": "星界戒指",
    "621171": "以太戒指",
    "621181": "虚空戒指",
    "621191": "深渊戒指",
    "622011": "铜戒指",
    "622021": "青铜戒指",
    "622031": "银戒指",
    "622041": "金戒指",
    "622051": "铂金戒指",
    "622061": "水晶戒指",
    "622071": "琥珀戒指",
    "622081": "黄玉戒指",
    "622091": "紫水晶戒指",
    "622101": "石榴石戒指",
    "622111": "翡翠戒指",
    "622121": "钻石戒指",
    "622131": "月长石戒指",
    "622141": "蚀月戒指",
    "622151": "天界戒指",
    "622161": "星界戒指",
    "622171": "以太戒指",
    "622181": "虚空戒指",
    "622191": "深渊戒指",
    "623011": "铜戒指",
    "623021": "青铜戒指",
    "623031": "银戒指",
    "623041": "金戒指",
    "623051": "铂金戒指",
    "623061": "水晶戒指",
    "623071": "琥珀戒指",
    "623081": "黄玉戒指",
    "623091": "紫水晶戒指",
    "623101": "石榴石戒指",
    "623111": "翡翠戒指",
    "623121": "钻石戒指",
    "623131": "月长石戒指",
    "623141": "蚀月戒指",
    "623151": "天界戒指",
    "623161": "星界戒指",
    "623171": "以太戒指",
    "623181": "虚空戒指",
    "623191": "深渊戒指",
    "624011": "铜戒指",
    "624021": "青铜戒指",
    "624031": "银戒指",
    "624041": "金戒指",
    "624051": "铂金戒指",
    "624061": "水晶戒指",
    "624071": "琥珀戒指",
    "624081": "黄玉戒指",
    "624091": "紫水晶戒指",
    "624101": "石榴石戒指",
    "624111": "翡翠戒指",
    "624121": "钻石戒指",
    "624131": "月长石戒指",
    "624141": "蚀月戒指",
    "624151": "天界戒指",
    "624161": "星界戒指",
    "624171": "以太戒指",
    "624181": "虚空戒指",
    "624191": "深渊戒指",
    "625041": "金戒指",
    "625051": "铂金戒指",
    "625061": "水晶戒指",
    "625071": "琥珀戒指",
    "625081": "黄玉戒指",
    "625091": "紫水晶戒指",
    "625101": "石榴石戒指",
    "625111": "翡翠戒指",
    "625121": "钻石戒指",
    "625131": "月长石戒指",
    "625141": "蚀月戒指",
    "625151": "天界戒指",
    "625161": "星界戒指",
    "625171": "以太戒指",
    "625181": "虚空戒指",
    "625191": "深渊戒指",
    "626061": "水晶戒指",
    "626071": "琥珀戒指",
    "626081": "黄玉戒指",
    "626091": "紫水晶戒指",
    "626101": "石榴石戒指",
    "626111": "翡翠戒指",
    "626121": "钻石戒指",
    "626131": "月长石戒指",
    "626141": "蚀月戒指",
    "626151": "天界戒指",
    "626161": "星界戒指",
    "626171": "以太戒指",
    "626181": "虚空戒指",
    "626191": "深渊戒指",
    "627081": "黄玉戒指",
    "627091": "紫水晶戒指",
    "627101": "石榴石戒指",
    "627111": "翡翠戒指",
    "627121": "钻石戒指",
    "627131": "月长石戒指",
    "627141": "蚀月戒指",
    "627151": "天界戒指",
    "627161": "星界戒指",
    "627171": "以太戒指",
    "627181": "虚空戒指",
    "627191": "深渊戒指",
    "628101": "石榴石戒指",
    "628111": "翡翠戒指",
    "628121": "钻石戒指",
    "628131": "月长石戒指",
    "628141": "蚀月戒指",
    "628151": "天界戒指",
    "628161": "星界戒指",
    "628171": "以太戒指",
    "628181": "虚空戒指",
    "628191": "深渊戒指",
    "629121": "钻石戒指",
    "629131": "月长石戒指",
    "629141": "蚀月戒指",
    "629151": "天界戒指",
    "629161": "星界戒指",
    "629171": "以太戒指",
    "629181": "虚空戒指",
    "629191": "深渊戒指",
    "631011": "铜制护腕",
    "631021": "青铜护腕",
    "631031": "银制臂甲",
    "631041": "黄金臂甲",
    "631051": "铂金护腕",
    "631061": "水晶护腕",
    "631071": "黑曜石腕甲",
    "631081": "暗影护腕",
    "631091": "绯红腕甲",
    "631101": "血石腕甲",
    "631111": "祖母绿护腕",
    "631121": "钻石护腕",
    "631131": "星尘臂甲",
    "631141": "日食臂甲",
    "631151": "天界护腕",
    "631161": "星界护腕",
    "631171": "以太腕甲",
    "631181": "虚空护腕",
    "631191": "深渊腕甲",
    "632011": "铜制护腕",
    "632021": "青铜护腕",
    "632031": "银制臂甲",
    "632041": "黄金臂甲",
    "632051": "铂金护腕",
    "632061": "水晶护腕",
    "632071": "黑曜石腕甲",
    "632081": "暗影护腕",
    "632091": "绯红腕甲",
    "632101": "血石腕甲",
    "632111": "祖母绿护腕",
    "632121": "钻石护腕",
    "632131": "星尘臂甲",
    "632141": "日食臂甲",
    "632151": "天界护腕",
    "632161": "星界护腕",
    "632171": "以太腕甲",
    "632181": "虚空护腕",
    "632191": "深渊腕甲",
    "633011": "铜制护腕",
    "633021": "青铜护腕",
    "633031": "银制臂甲",
    "633041": "黄金臂甲",
    "633051": "铂金护腕",
    "633061": "水晶护腕",
    "633071": "黑曜石腕甲",
    "633081": "暗影护腕",
    "633091": "绯红腕甲",
    "633101": "血石腕甲",
    "633111": "祖母绿护腕",
    "633121": "钻石护腕",
    "633131": "星尘臂甲",
    "633141": "日食臂甲",
    "633151": "天界护腕",
    "633161": "星界护腕",
    "633171": "以太腕甲",
    "633181": "虚空护腕",
    "633191": "深渊腕甲",
    "634011": "铜制护腕",
    "634021": "青铜护腕",
    "634031": "银制臂甲",
    "634041": "黄金臂甲",
    "634051": "铂金护腕",
    "634061": "水晶护腕",
    "634071": "黑曜石腕甲",
    "634081": "暗影护腕",
    "634091": "绯红腕甲",
    "634101": "血石腕甲",
    "634111": "祖母绿护腕",
    "634121": "钻石护腕",
    "634131": "星尘臂甲",
    "634141": "日食臂甲",
    "634151": "天界护腕",
    "634161": "星界护腕",
    "634171": "以太腕甲",
    "634181": "虚空护腕",
    "634191": "深渊腕甲",
    "635041": "黄金臂甲",
    "635051": "铂金护腕",
    "635061": "水晶护腕",
    "635071": "黑曜石腕甲",
    "635081": "暗影护腕",
    "635091": "绯红腕甲",
    "635101": "血石腕甲",
    "635111": "祖母绿护腕",
    "635121": "钻石护腕",
    "635131": "星尘臂甲",
    "635141": "日食臂甲",
    "635151": "天界护腕",
    "635161": "星界护腕",
    "635171": "以太腕甲",
    "635181": "虚空护腕",
    "635191": "深渊腕甲",
    "636061": "水晶护腕",
    "636071": "黑曜石腕甲",
    "636081": "暗影护腕",
    "636091": "绯红腕甲",
    "636101": "血石腕甲",
    "636111": "祖母绿护腕",
    "636121": "钻石护腕",
    "636131": "星尘臂甲",
    "636141": "日食臂甲",
    "636151": "天界护腕",
    "636161": "星界护腕",
    "636171": "以太腕甲",
    "636181": "虚空护腕",
    "636191": "深渊腕甲",
    "637081": "暗影护腕",
    "637091": "绯红腕甲",
    "637101": "血石腕甲",
    "637111": "祖母绿护腕",
    "637121": "钻石护腕",
    "637131": "星尘臂甲",
    "637141": "日食臂甲",
    "637151": "天界护腕",
    "637161": "星界护腕",
    "637171": "以太腕甲",
    "637181": "虚空护腕",
    "637191": "深渊腕甲",
    "638101": "血石腕甲",
    "638111": "祖母绿护腕",
    "638121": "钻石护腕",
    "638131": "星尘臂甲",
    "638141": "日食臂甲",
    "638151": "天界护腕",
    "638161": "星界护腕",
    "638171": "以太腕甲",
    "638181": "虚空护腕",
    "638191": "深渊腕甲",
    "639121": "钻石护腕",
    "639131": "星尘臂甲",
    "639141": "日食臂甲",
    "639151": "天界护腕",
    "639161": "星界护腕",
    "639171": "以太腕甲",
    "639181": "虚空护腕",
    "639191": "深渊腕甲",
    "910011": "Normal Monster Box 1",
    "910051": "Normal Monster Box 2",
    "910101": "Normal Monster Box 3",
    "910151": "Normal Monster Box Lv15",
    "910201": "Normal Monster Box Lv20",
    "910251": "Normal Monster Box Lv25",
    "910301": "Normal Monster Box Lv30",
    "910351": "Normal Monster Box Lv35",
    "910401": "Normal Monster Box Lv40",
    "910451": "Normal Monster Box Lv45",
    "910501": "Normal Monster Box Lv50",
    "910551": "Normal Monster Box Lv55",
    "910601": "Normal Monster Box Lv60",
    "910651": "Normal Monster Box Lv65",
    "910701": "Normal Monster Box Lv70",
    "910751": "Normal Monster Box Lv75",
    "910801": "Normal Monster Box Lv80",
    "910851": "Normal Monster Box Lv85",
    "910901": "Normal Monster Box Lv90",
    "920001": "Stage Boss Box 1",
    "920002": "Stage Boss Box 2",
    "920003": "Stage Boss Box 3",
    "920004": "Stage Boss Box 3",
    "920005": "Stage Boss Box 3",
    "920006": "Stage Boss Box 3",
    "920011": "Stage Boss Box 4",
    "920022": "Stage Boss Box 6",
    "920051": "Stage Boss Box 5",
    "920101": "Stage Boss Box 7",
    "920151": "Stage Boss Box Lv15",
    "920201": "Stage Boss Box Lv20",
    "920251": "Stage Boss Box Lv25",
    "920301": "Stage Boss Box Lv30",
    "920351": "Stage Boss Box Lv35",
    "920401": "Stage Boss Box Lv40",
    "920451": "Stage Boss Box Lv45",
    "920501": "Stage Boss Box Lv50",
    "920551": "Stage Boss Box Lv55",
    "920601": "Stage Boss Box Lv60",
    "920651": "Stage Boss Box Lv65",
    "920701": "Stage Boss Box Lv70",
    "920751": "Stage Boss Box Lv75",
    "920801": "Stage Boss Box Lv80",
    "920851": "Stage Boss Box Lv85",
    "920901": "Stage Boss Box Lv90",
    "930101": "Act Boss Box 1",
    "930201": "Act Boss Box Lv20",
    "930301": "Act Boss Box Lv30",
    "930401": "Act Boss Box Lv40",
    "930451": "Act Boss Box Lv45",
    "930501": "Act Boss Box Lv50",
    "930601": "Act Boss Box Lv60",
    "930651": "Act Boss Box Lv65",
    "930701": "Act Boss Box Lv70",
    "930851": "Act Boss Box Lv85",
    "930901": "Act Boss Box Lv90",
};

function colorOf(id) {
    var g = g_gradeMap[id] || null;
    return g ? (GRADE_ANSI[g] || '') : '';
}

function watchEntryForConfig(entry) {
    if (entry && typeof entry === 'object') {
        var rawId = entry.id !== undefined && entry.id !== null ? ('' + entry.id).trim() : '';
        if (rawId) {
            var gradeKeyById = g_gradeMap[rawId] || '';
            return {
                id: rawId,
                name: g_nameMap[rawId] || (entry.name ? ('' + entry.name).trim() : ''),
                grade: g_gradeChinese[gradeKeyById] || (entry.grade ? ('' + entry.grade).trim() : '')
            };
        }
        return {
            id: '',
            name: entry.name ? ('' + entry.name).trim() : '',
            grade: entry.grade ? ('' + entry.grade).trim() : ''
        };
    }

    var name = ('' + entry).trim();
    if (!name) return null;
    var best = null;
    for (var id in g_nameMap) {
        if (!Object.prototype.hasOwnProperty.call(g_nameMap, id)) continue;
        if (g_nameMap[id] !== name) continue;
        if (!best || gradeRankForId(id) > gradeRankForId(best.id)) {
            var gradeKey = g_gradeMap[id] || '';
            best = {
                id: '' + id,
                name: name,
                grade: g_gradeChinese[gradeKey] || ''
            };
        }
    }
    return best || {
        id: '',
        name: name,
        grade: ''
    };
}

function watchEntryForItem(itemId) {
    var cfg = g_config && g_config.watch ? g_config.watch : null;
    if (!cfg || !cfg.enabled) return null;
    var id = '' + itemId;
    var name = g_nameMap[id] || '';
    var grade = g_gradeChinese[g_gradeMap[id] || ''] || '';
    var names = cfg.names || [];
    for (var n = 0; n < names.length; n++) {
        var target = watchEntryForConfig(names[n]);
        if (!target) continue;
        if (target.id && target.id === id) return target;
        if (target.name === name && target.grade && target.grade === grade) return target;
    }
    return null;
}

function gradeRankForId(itemId) {
    var order = ['', 'COMMON', 'UNCOMMON', 'RARE', 'LEGENDARY', 'IMMORTAL', 'ARCANA', 'BEYOND', 'CELESTIAL', 'DIVINE', 'COSMIC'];
    var gradeKey = g_gradeMap['' + itemId] || '';
    for (var i = 0; i < order.length; i++) {
        if (order[i] === gradeKey) return i;
    }
    return 0;
}

function isWatchedItem(itemId) {
    return !!watchEntryForItem(itemId);
}

function itemLabel(itemId, highlight) {
    var id = '' + itemId;
    var name = g_nameMap[id] || '?';
    var grade = g_gradeMap[id] || '';
    var c = colorOf(id);
    var cn = g_gradeChinese[grade] || '';
    var padName = padRight(name, ITEM_NAME_COL_WIDTH);
    var padGrade = padRight(cn, ITEM_GRADE_COL_WIDTH);
    var line = padName + padGrade + id;
    if (highlight) {
        var bg = (g_config && g_config.watch && g_config.watch.highlightBackgroundAnsi) || '\x1b[48;5;52m';
        return bg + line + ANSI_RESET;
    }
    if (c) line = c + line;
    if (c) return line + ANSI_RESET;
    return line;
}

function itemHeader() {
    return padRight('名字', ITEM_NAME_COL_WIDTH) + padRight('品质', ITEM_GRADE_COL_WIDTH) + 'id';
}

function itemPlain(itemId) {
    var id = '' + itemId;
    var grade = g_gradeMap[id] || '';
    return {
        id: id,
        name: g_nameMap[id] || '?',
        grade: g_gradeChinese[grade] || '',
        gradeKey: grade,
        watched: isWatchedItem(itemId)
    };
}

function watchLimitForQueue(q) {
    var display = (g_config && g_config.display) ? g_config.display : {};
    if (!q) return 0;
    if (q.eboxType === 0) return parseInt(display.normalCount, 10) || 10;
    if (q.eboxType === 1) return parseInt(display.bossCount, 10) || 5;
    if (q.eboxType === 2) return parseInt(display.actCount, 10) || 10;
    return q.items ? q.items.length : 0;
}

function watchedItemsInQueues(queues) {
    var found = [];
    if (!queues) return found;
    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        if (!q || !q.items) continue;
        if (q.eboxType !== 0 && q.eboxType !== 1) continue;
        for (var ii = 0; ii < q.items.length; ii++) {
            var raw = q.items[ii];
            var itemId = raw && typeof raw === 'object' ? raw.id : raw;
            var rawWatched = !!(raw && typeof raw === 'object' && raw.watched);
            if (!rawWatched && !isWatchedItem(itemId)) continue;
            var id = '' + itemId;
            var plain = itemPlain(itemId);
            if (raw && typeof raw === 'object') {
                plain.name = raw.name || plain.name;
                plain.grade = raw.grade || plain.grade;
                plain.gradeKey = raw.gradeKey || plain.gradeKey;
            }
            plain.watched = true;
            plain.queueLabel = q.label;
            plain.position = ii + 1;
            plain.watchLimit = limit;
            found.push(plain);
        }
    }
    return found;
}

function watchedItemsText(items) {
    if (!items || items.length === 0) return '';
    var parts = [];
    for (var i = 0; i < items.length; i++) {
        var extra = '';
        if (items[i].queueLabel) extra = ' ' + items[i].queueLabel + '#' + items[i].position + '/' + items[i]
        .watchLimit;
        parts.push(items[i].name + '(' + items[i].id + extra + ')');
    }
    return parts.join(', ');
}

function monitorHoldProgressText() {
    var parts = [];
    if (ui_monitorHoldExpectedNormal > 0) {
        parts.push('普通 ' + ui_monitorHoldDeletedNormal + '/' + ui_monitorHoldExpectedNormal);
    }
    if (ui_monitorHoldExpectedBoss > 0) {
        parts.push('首领 ' + ui_monitorHoldDeletedBoss + '/' + ui_monitorHoldExpectedBoss);
    }
    if (parts.length <= 0) {
        parts.push(ui_monitorHoldDeletedCount + '/' + ui_monitorHoldExpectedCount);
    }
    return parts.join('，');
}

function removeDroppedFromMonitorHold(itemId) {
    var target = '' + itemId;
    var removed = false;
    var kept = [];
    for (var i = 0; i < ui_monitorHoldItems.length; i++) {
        var item = ui_monitorHoldItems[i] || {};
        if (!removed && ('' + item.id) === target) {
            removed = true;
            continue;
        }
        kept.push(item);
    }
    ui_monitorHoldItems = kept;
    return removed;
}

function queueFirstItemText(queues, eboxType) {
    if (!queues) return '无';
    for (var i = 0; i < queues.length; i++) {
        var q = queues[i];
        if (!q || q.eboxType !== eboxType || !q.items || q.items.length <= 0) continue;
        var raw = q.items[0];
        var itemId = raw && typeof raw === 'object' ? raw.id : raw;
        var plain = itemPlain(itemId);
        return plain.name + (plain.grade ? ' ' + plain.grade : '') + '(' + plain.id + ')';
    }
    return '无';
}

function uiLogNextDropSummary(stageName, queues) {
    if (!stageName || !queues || queues.length <= 0) return;
    uiStatus('[循环] ' + stageName + '下次掉落【普通箱：' + queueFirstItemText(queues, 0) + '】【首领箱：' + queueFirstItemText(queues, 1) + '】');
}

function uiNormalizeStageLabel(label) {
    if (!label) return '';
    label = '' + label;
    if (label === '#1' || label === '折磨1-2' || label === '1-2' || label === '低等级关卡') return '低等级关卡';
    if (label === '#2' || label === '折磨1-3' || label === '1-3' || label === '高等级关卡') return '高等级关卡';
    return label;
}

function uiIsLowStage(label) {
    return uiNormalizeStageLabel(label) === '低等级关卡';
}

function uiIsHighStage(label) {
    return uiNormalizeStageLabel(label) === '高等级关卡';
}

function uiOtherTimeStageIndex(index) {
    return parseInt(index, 10) === 0 ? 1 : 0;
}

function uiTimeStageNameByIndex(index) {
    return parseInt(index, 10) === 0 ? '低等级关卡' : '高等级关卡';
}

function uiTimeLoopLogByIndex(index) {
    return parseInt(index, 10) === 0 ? '[循环] 前往低等级关卡' : '[循环] 前往高等级关卡';
}

function uiTimeStageFromBoxItemId(itemId) {
    itemId = parseInt(itemId, 10);
    if (isNaN(itemId)) return '';
    var suffix = itemId % 1000;
    if (suffix >= 10 && suffix % 10 === 1) return 'LV' + Math.floor(suffix / 10);
    if (suffix > 0) return 'LV' + suffix;
    return '';
}

function itemShort(itemId) {
    var id = '' + itemId;
    var name = g_nameMap[id] || '';
    var grade = g_gradeMap[id] || '';
    var c = colorOf(id);
    var cn = g_gradeChinese[grade] || '';
    if (c && name) return c + name + ANSI_RESET;
    if (c && cn) return c + '[' + cn + ']' + ANSI_RESET + ' ' + id;
    return '' + id;
}

function displayQueue(q) {
    var showCount = Math.min(q.items.length, 10);
    log('  [' + q.label + ']  ' + q.items.length + '\u9879  (显示前' + showCount + '\u9879)');
    for (var i = 0; i < showCount; i++) {
        log('    ' + itemLabel(q.items[i]));
    }
    if (q.items.length > showCount) log('    ... +' + (q.items.length - showCount) + '\u9879\u672a\u663e\u793a');
    if (q.items.length > 0) log('    >> \u4e0b\u4e00\u4e2a: ' + itemLabel(q.items[0]) + ' <<');
}

function queuesChanged(queues) {
    if (!g_queuesDisplayed) return true;
    if (g_snapshots.size !== queues.length) return true;

    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        var key = 'bexl:' + q.eboxType;
        var old = g_snapshots.get(key);
        if (!old) return true;
        if (old.items.length !== q.items.length) return true;
        for (var i = 0; i < q.items.length; i++) {
            if (old.items[i] !== q.items[i]) return true;
        }
    }
    return false;
}

function queueSignature(queues) {
    if (!queues || queues.length === 0) return '';
    var parts = [];
    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        var ids = (q.items || []).map(function(item) {
            return item && typeof item === 'object' ? item.id : item;
        });
        parts.push(q.eboxType + ':' + ids.join(','));
    }
    return parts.join('|');
}

function saveQueueSnapshots(queues) {
    g_snapshots.clear();
    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        g_snapshots.set('bexl:' + q.eboxType, {
            eboxType: q.eboxType,
            label: q.label,
            items: q.items.slice(),
            size: q.size
        });
    }
}

function responseMemoryQueueLabel(eboxType) {
    return eboxType === 1 ? '首领掉落' : '普通掉落';
}

function responseMemoryStageFromBoxes(boxes) {
    for (var i = 0; i < boxes.length; i++) {
        var stage = uiTimeStageFromBoxItemId(boxes[i].itemId);
        if (stage) return stage;
    }
    return '';
}

function uiNextTimeIndexFromStage(stageLabel) {
    stageLabel = uiNormalizeStageLabel(stageLabel);
    if (stageLabel === '高等级关卡') return 0;
    if (stageLabel === '低等级关卡') return 1;
    if (ui_lastTimeStageClickIndex >= 0) return uiOtherTimeStageIndex(ui_lastTimeStageClickIndex);
    return 1;
}

function uiSyncRecordedStagePreference() {
    if (ui_lastRecordedStageIndex === 0 && ui_recorded[0]) {
        ui_lastTimeStageSeen = '低等级关卡';
        return;
    }
    if (ui_lastRecordedStageIndex === 1 && ui_recorded[1]) {
        ui_lastTimeStageSeen = '高等级关卡';
        return;
    }
    if (ui_recorded[0]) {
        ui_lastTimeStageSeen = '低等级关卡';
        return;
    }
    if (ui_recorded[1]) {
        ui_lastTimeStageSeen = '高等级关卡';
        return;
    }
    ui_lastTimeStageSeen = '';
}

function uiLoopStartTimeIndexFromRecorded() {
    if (ui_lastRecordedStageIndex === 0 && ui_recorded[1]) return 1;
    if (ui_lastRecordedStageIndex === 1 && ui_recorded[0]) return 0;
    if (ui_lastRecordedStageIndex === 0) return 0;
    if (ui_lastRecordedStageIndex === 1) return 1;
    if (ui_recorded[0] && !ui_recorded[1]) return 0;
    if (ui_recorded[1] && !ui_recorded[0]) return 1;
    return -1;
}

function responseMemoryBuildQueues(boxes) {
    var normal = [];
    var boss = [];
    for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i] || {};
        if (box.isGet === true) continue;
        var rewardId = parseInt(box.rewardItemId, 10);
        if (isNaN(rewardId) || rewardId <= 0) continue;
        var itemId = parseInt(box.itemId, 10);
        var item = itemPlain(rewardId);
        item.itemKey = '' + (box.itemKey || '');
        item.rewardItemKey = '' + (box.rewardItemKey || '');
        item.isGet = box.isGet === true;
        if (!isNaN(itemId) && ('' + itemId).indexOf('920') === 0) boss.push(item);
        else normal.push(item);
    }
    var queues = [];
    if (normal.length > 0) queues.push({
        eboxType: 0,
        label: responseMemoryQueueLabel(0),
        items: normal,
        size: normal.length
    });
    if (boss.length > 0) queues.push({
        eboxType: 1,
        label: responseMemoryQueueLabel(1),
        items: boss,
        size: boss.length
    });
    return queues;
}

function responseMemoryTryParseText(text) {
    try {
        if (!text || text.indexOf('rewardItemId') < 0 || text.indexOf('boxes') < 0) return null;
        var start = text.indexOf('{"result"');
        if (start < 0) start = text.indexOf('{\"result\"');
        if (start < 0) start = text.indexOf('{');
        if (start < 0) return null;
        var end = text.lastIndexOf('}');
        if (end <= start) return null;
        var raw = text.substring(start, Math.min(end + 1, start + 260000));
        var outer = JSON.parse(raw);
        var inner = outer && outer.result;
        if (typeof inner === 'string') inner = JSON.parse(inner);
        if (!inner || !inner.data || !inner.data.boxes || !inner.data.boxes.length) return null;
        var boxes = inner.data.boxes;
        var queues = responseMemoryBuildQueues(boxes);
        if (queues.length === 0) return null;
        return {
            boxes: boxes,
            queues: queues,
            stage: responseMemoryStageFromBoxes(boxes),
            sig: queueSignature(queues)
        };
    } catch (e) {
        return null;
    }
}

function responseMemoryReadCandidate(address) {
    try {
        var start = ptr(address).sub(8192);
        var range = Process.findRangeByAddress(ptr(address));
        if (range && start.compare(range.base) < 0) start = range.base;
        var len = 220000;
        if (range) {
            var maxLen = range.base.add(range.size).sub(start).toInt32();
            len = Math.max(1024, Math.min(len, maxLen));
        }
        return start.readUtf8String(len);
    } catch (e) {
        return '';
    }
}

function responseMemoryHandleQueues(parsed, source, baselineSig) {
    if (!parsed || !parsed.queues || parsed.queues.length === 0) return false;
    if (baselineSig && parsed.sig === baselineSig) return false;
    if (parsed.sig === g_responseMemoryLastSig) return false;
    g_responseMemoryLastSig = parsed.sig;
    if (parsed.stage) {
        ui_currentStageLabel = parsed.stage;
        ui_pendingStageLabel = '';
    }
    saveQueueSnapshots(parsed.queues);
    g_queuesDisplayed = true;
    try {
        send({
            type: 'drop_update',
            source: source || '内存响应',
            currentStage: uiCurrentStageDisplayName(),
            currentStageRaw: ui_currentStageLabel || ui_pendingStageLabel || ui_lastClickedStageLabel || '',
            queues: parsed.queues.map(function(q) {
                return {
                    eboxType: q.eboxType,
                    label: q.label,
                    size: q.items.length,
                    items: q.items
                };
            }),
            config: g_config
        });
    } catch (e) {}
    uiOnDropQueuesShown(source || '内存响应', parsed.queues, parsed.sig);
    return true;
}

function scanResponseMemoryOnce(source, baselineSig, applyResult) {
    if (applyResult === undefined) applyResult = true;
    var nowMs = Date.now();
    if (nowMs - g_responseMemoryLastScanMs < 250) return false;
    g_responseMemoryLastScanMs = nowMs;
    var pattern = '5C 22 72 65 65 77 61 72 64 49 74 65 6D 49 64 5C 22';
    var ranges = Process.enumerateRanges({
        protection: 'rw-',
        coalesce: true
    });
    ranges = ranges.concat(Process.enumerateRanges({
        protection: 'r--',
        coalesce: true
    }));
    var maxRanges = 220;
    var hitsLeft = 12;
    for (var ri = 0; ri < ranges.length && ri < maxRanges; ri++) {
        var r = ranges[ri];
        if (!r || r.size < 4096 || r.size > 64 * 1024 * 1024) continue;
        var found = false;
        try {
            Memory.scanSync(r.base, r.size, pattern).some(function(match) {
                if (hitsLeft-- <= 0) return true;
                var text = responseMemoryReadCandidate(match.address);
                var parsed = responseMemoryTryParseText(text);
                if (!parsed || !parsed.sig || (baselineSig && parsed.sig === baselineSig)) return false;
                if (!applyResult) {
                    g_responseMemoryLastSig = parsed.sig;
                    found = true;
                    return true;
                }
                if (responseMemoryHandleQueues(parsed, source, baselineSig)) {
                    found = true;
                    return true;
                }
                return false;
            });
        } catch (e) {}
        if (found) return true;
    }
    return false;
}

function responseMemoryCurrentSignature() {
    try {
        var last = g_responseMemoryLastSig;
        g_responseMemoryLastSig = '';
        var ok = scanResponseMemoryOnce('内存响应基线', '', false);
        var sig = g_responseMemoryLastSig || last || '';
        g_responseMemoryLastSig = last;
        return ok ? sig : '';
    } catch (e) {
        return '';
    }
}

function scheduleBexlRefresh(source, baselineSig) {
    var seq = ++g_refreshSeq;
    var delays = [
        0, 100, 250, 500, 1000, 1500, 2500, 4000, 6000, 10000, 15000
    ];
    var printedOnce = false;
    for (var i = 0; i < delays.length; i++) {
        (function(delay, isLast) {
            setTimeout(function() {
                if (seq !== g_refreshSeq) return;
                var queues = readBexlQueues(source || 'schedule');
                if (queues.length === 0) return;

                var sig = queueSignature(queues);
                var changedFromBaseline = !baselineSig || sig !== baselineSig;
                if (!printedOnce || changedFromBaseline || isLast) {
                    var printed = showBexlQueues(source, !printedOnce || isLast);
                    if (printed) printedOnce = true;
                }
            }, delay);
        })(delays[i], i === delays.length - 1);
    }
}

function uiStageDisplayName(label) {
    if (!label) return '';
    var m = ('' + label).match(/(\d+-\d+)/);
    if (m) return '折磨' + m[1];
    return uiNormalizeStageLabel(label);
}

function uiCurrentStageDisplayName() {
    return uiStageDisplayName(ui_currentStageLabel || ui_pendingStageLabel || ui_lastClickedStageLabel);
}

function showBexlQueues(source, force) {
    var queues = readBexlQueues(source || 'show');
    if (queues.length === 0) return false;
    var sig = queueSignature(queues);
    var changed = queuesChanged(queues);
    if (g_queuesDisplayed && !changed && !force) return true;
    uiConfirmStageFromList(source);
    saveQueueSnapshots(queues);
    try {
        send({
            type: 'drop_update',
            source: source,
            currentStage: uiCurrentStageDisplayName(),
            currentStageRaw: ui_currentStageLabel || ui_pendingStageLabel || ui_lastClickedStageLabel || '',
            queues: queues.map(function(q) {
                return {
                    eboxType: q.eboxType,
                    label: q.label,
                    size: q.items.length,
                    items: q.items.map(itemPlain)
                };
            }),
            config: g_config
        });
    } catch (e) {}
    if (g_config && g_config.display && g_config.display.clearBeforePrint) {
        console.log('\x1b[2J\x1b[H');
    }

    // 为每个队列生成行数组 (并排显示)
    var columns = [];
    for (var qi = 0; qi < queues.length; qi++) {
        var q = queues[qi];
        var maxShow = g_config.display.normalCount || 10;
        if (q.eboxType === 1) maxShow = g_config.display.bossCount || 5;
        if (q.eboxType === 2) maxShow = g_config.display.actCount || 10;
        var shown = q.items.slice(0, maxShow);
        var remaining = q.items.length - shown.length;
        var lines = [];
        // 表头
        lines.push('[' + q.label + ']  ' + q.items.length + '\u9879' + (q.items.length > 0 ? '  (\u663e\u793a\u524d' +
            maxShow + ')' : ''));
        // 物品列表, 每行一个
        for (var i = 0; i < shown.length; i++) {
            lines.push(itemLabel(shown[i], isWatchedItem(shown[i])));
        }
        // 未显示提示
        if (remaining > 0) {
            lines.push('+' + remaining + '\u9879\u672a\u663e\u793a');
        }
        columns.push(lines);
    }

    // 计算每列宽度 (取该列最大显示宽度 + 4空格间隔)
    var colWidths = [];
    for (var ci = 0; ci < columns.length; ci++) {
        var maxW = 0;
        for (var li = 0; li < columns[ci].length; li++) {
            var w = dispWidth(columns[ci][li]);
            if (w > maxW) maxW = w;
        }
        colWidths.push(maxW + 4);
    }

    // 最大行数
    var maxLines = 0;
    for (var ci = 0; ci < columns.length; ci++) {
        if (columns[ci].length > maxLines) maxLines = columns[ci].length;
    }

    var stageText = uiCurrentStageDisplayName();
    // 并排输出
    log(stageText ? (stageText + '掉落列表') : '掉落列表');
    log('[' + source + '] ' + queues.length + ' \u4e2a\u6389\u843d\u961f\u5217' + (stageText ?
        '  \u5f53\u524d\u5173\u5361\uff1a' + stageText : '') + ':');
    for (var li = 0; li < maxLines; li++) {
        var line = '  ';
        for (var ci = 0; ci < columns.length; ci++) {
            var cell = li < columns[ci].length ? columns[ci][li] : '';
            if (ci < columns.length - 1) {
                line += padRight(cell, colWidths[ci]);
            } else {
                line += cell;
            }
        }
        log(line);
    }

    uiOnDropQueuesShown(source, queues, sig);

    g_queuesDisplayed = true;
    return true;
}

log('\u2713 \u52a0\u8f7d\u5185\u5d4c\u6570\u636e: grade ' + Object.keys(g_gradeMap).length + ' \u6761, name ' + Object
    .keys(g_nameMap).length + ' \u6761');
log('[config] normal=' + g_config.display.normalCount + ', boss=' + g_config.display.bossCount + ', watch=' + (g_config
    .watch.names || []).join('|') + ', ids=' + (g_config.watch.ids || []).join('|'));

log('\n=== Drop Items Info v4 \u5c31\u7eea ===');

// ======== UI stage button replay ========
var UI_LOOP_INTERVAL_MS = 15000;
var UI_TIME_RESPONSE_TIMEOUT_MS = 10000;
var UI_TIME_NO_RESPONSE_DELAY_MS = 600000;

function uiNextAfterDropDelayMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var delay = parseInt(display.clickDelayMs, 10);
    return isNaN(delay) ? 3000 : Math.max(0, delay);
}

function uiLoopPauseExtraDelayMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var every = parseInt(display.loopPauseEvery, 10);
    var pause = parseInt(display.loopPauseMs, 10);
    if (isNaN(every) || isNaN(pause) || every <= 0 || pause <= 0) return 0;
    if (ui_completedLoopCount <= 0 || ui_completedLoopCount % every !== 0) return 0;
    return Math.max(0, pause);
}

function uiPressIntervalMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var delay = parseInt(display.pressIntervalMs, 10);
    return isNaN(delay) ? 450 : Math.max(0, delay);
}

function uiRoleDeployDelayMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var delay = parseInt(display.roleDeployDelayMs, 10);
    return isNaN(delay) ? 800 : Math.max(0, delay);
}

function uiSwitchMode() {
    return 'time';
}

function uiSaveCurrentRecordSet(mode) {
    mode = 'time';
    if (!ui_recordSets[mode]) ui_recordSets[mode] = { recorded: [], labels: [], kinds: [], points: [], stageInfos: [], difficulties: [] };
    ui_recordSets[mode].recorded = ui_recorded.slice();
    ui_recordSets[mode].labels = ui_recordedLabels.slice();
    ui_recordSets[mode].kinds = ui_recordedKinds.slice();
    ui_recordSets[mode].points = ui_recordedPoints.slice();
    ui_recordSets[mode].stageInfos = ui_recordedStageInfos.map(uiSerializeStageInfo);
    ui_recordSets[mode].difficulties = ui_recordedDifficulties.slice();
}

function uiUseRecordSet(mode) {
    mode = 'time';
    if (!ui_recordSets[mode]) ui_recordSets[mode] = { recorded: [], labels: [], kinds: [], points: [], stageInfos: [], difficulties: [] };
    ui_recorded = ui_recordSets[mode].recorded.slice();
    ui_recordedLabels = ui_recordSets[mode].labels.slice();
    ui_recordedKinds = (ui_recordSets[mode].kinds || []).slice();
    ui_recordedPoints = (ui_recordSets[mode].points || []).slice();
    ui_recordedStageInfos = (ui_recordSets[mode].stageInfos || []).map(uiHydrateStageInfo);
    ui_recordedDifficulties = (ui_recordSets[mode].difficulties || []).slice();
    ui_recordedKeys = {};
    for (var i = 0; i < ui_recorded.length; i++) {
        if (i >= UI_CROSS_START && i < UI_CROSS_START + UI_CROSS_COUNT && ui_recordedKinds[i] === 'stage') {
            ui_recordedKinds[i] = 'button';
            ui_recordedStageInfos[i] = null;
        }
        if (ui_recorded[i]) ui_recordedKeys[ui_recorded[i].toString()] = true;
        if (ui_recorded[i] && !ui_recordedKinds[i]) ui_recordedKinds[i] = 'button';
    }
}

function uiTimeShiftEvery() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var every = parseInt(display.timeShiftEvery, 10);
    return isNaN(every) || every <= 0 ? 16 : every;
}

function uiTimeShiftRestoreMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var delay = parseInt(display.timeShiftRestoreMs, 10);
    return isNaN(delay) ? 2000 : Math.max(0, delay);
}

function uiTimeShiftContinueMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var delay = parseInt(display.timeShiftContinueMs, 10);
    return isNaN(delay) ? 3000 : Math.max(0, delay);
}

function uiAutoTimeShiftOnLimitEnabled() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    return display.autoTimeShiftOnLimit === true;
}

function uiAutoDepositEnabled() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    return display.autoDepositEnabled === true;
}

function uiAutoDepositIntervalMs() {
    var display = (g_config && g_config.display) ? g_config.display : {};
    var minutes = parseInt(display.autoDepositMinutes, 10);
    if (isNaN(minutes) || minutes <= 0) minutes = 30;
    return Math.max(1, minutes) * 60000;
}

function uiAutoDepositIndexes() {
    var maxPageIndex = -1;
    for (var i = 4; i <= 10; i++) {
        if (ui_recorded[i]) maxPageIndex = i;
    }
    if (!ui_recorded[2] || !ui_recorded[3] || maxPageIndex < 4) return [];
    var indexes = [2];
    for (var pageIndex = 4; pageIndex <= maxPageIndex; pageIndex++) {
        if (!ui_recorded[pageIndex]) return [];
        indexes.push(pageIndex);
        indexes.push(3);
    }
    indexes.push(2);
    return indexes;
}

function uiAutoDepositReady() {
    var indexes = uiAutoDepositIndexes();
    if (indexes.length === 0) return false;
    for (var i = 0; i < indexes.length; i++) {
        var idx = indexes[i];
        if (!ui_recorded[idx]) return false;
    }
    return true;
}

function uiStartAutoDeposit(reason) {
    if (!uiAutoDepositEnabled() || ui_autoDepositRunning) return false;
    if (ui_waitingForDrop || ui_monitorHold || ui_waitingTimeShift) return false;
    if (!uiAutoDepositReady()) {
        uiStatusThrottled('auto_deposit_missing', '[自动入库] 请至少录制仓库按钮、放入仓库、仓库1', 10000);
        return false;
    }
    var indexes = uiAutoDepositIndexes();
    ui_autoDepositPendingPresses = [];
    for (var i = 0; i < indexes.length; i++) ui_autoDepositPendingPresses.push({ index: indexes[i], deposit: true });
    ui_autoDepositRunning = true;
    ui_autoDepositLastRunMs = Date.now();
    uiStatus('[自动入库] 开始执行' + (reason ? '：' + reason : ''));
    return true;
}

function uiClearAutoDepositTimer() {
    if (ui_autoDepositTimer) clearTimeout(ui_autoDepositTimer);
    ui_autoDepositTimer = null;
}

function uiScheduleAutoDepositTimer(delayMs) {
    uiClearAutoDepositTimer();
    if (!uiAutoDepositEnabled()) return;
    ui_autoDepositTimer = setTimeout(function() {
        ui_autoDepositTimer = null;
        uiAutoDepositTick();
    }, Math.max(1000, delayMs || uiAutoDepositIntervalMs()));
}

function uiAutoDepositTick() {
    if (!uiAutoDepositEnabled()) {
        uiClearAutoDepositTimer();
        return;
    }
    if (ui_autoDepositRunning || ui_waitingForDrop || ui_monitorHold || ui_waitingTimeShift) {
        uiScheduleAutoDepositTimer(5000);
        return;
    }
    var nowMs = Date.now();
    var interval = uiAutoDepositIntervalMs();
    if (!ui_autoDepositLastRunMs) ui_autoDepositLastRunMs = nowMs;
    var elapsed = nowMs - ui_autoDepositLastRunMs;
    if (elapsed >= interval) {
        if (!uiStartAutoDeposit('每' + Math.round(interval / 60000) + '分钟')) {
            uiScheduleAutoDepositTimer(5000);
        }
        return;
    }
    uiScheduleAutoDepositTimer(interval - elapsed);
}

function uiCrossSideIndexes(side) {
    var start = UI_CROSS_START + (side === 'B' ? UI_CROSS_SIDE_COUNT : 0);
    var indexes = [];
    for (var i = start; i < start + UI_CROSS_SIDE_COUNT; i++) {
        if (ui_recorded[i]) indexes.push(i);
    }
    return indexes;
}

function uiCrossSideName(side) {
    var start = UI_CROSS_START + (side === 'B' ? UI_CROSS_SIDE_COUNT : 0);
    var difficulty = ui_recordedDifficulties[start];
    if (difficulty !== null && difficulty !== undefined && difficulty !== '') return uiDifficultyName(difficulty);
    return side === 'B' ? '难度2' : '难度1';
}

function uiOtherCrossSide(side) {
    return side === 'A' ? 'B' : 'A';
}

function uiCrossReady() {
    return uiCrossSideIndexes('A').length >= UI_CROSS_SIDE_COUNT && uiCrossSideIndexes('B').length >= UI_CROSS_SIDE_COUNT;
}

function uiQueueCrossSide(side) {
    var indexes = uiCrossSideIndexes(side);
    if (indexes.length === 0) {
        uiStatus('[跨难度] ' + side + ' 图尚未录制');
        return false;
    }
    for (var i = 0; i < indexes.length; i++) {
        ui_pendingPresses.push({
            index: indexes[i],
            cross: true,
            side: side,
            final: i === indexes.length - 1
        });
    }
    ui_crossLoopWaitingSide = side;
    uiStatus('[跨难度] 点击' + uiCrossSideName(side) + '关卡，共' + indexes.length + '步');
    return true;
}

function uiCrossLoopOnce() {
    if (!ui_crossLoopRunning) return;
    if (ui_monitorHold) {
        uiStatusThrottled('cross_monitor_hold', '[跨难度] 当前列表仍有监控物品，暂停点击：' + watchedItemsText(ui_monitorHoldItems), 3000);
        return;
    }
    if (ui_waitingForDrop || ui_pendingPresses.length > 0 || ui_waitingTimeShift) return;
    var side = ui_crossLoopNextSide === 'B' ? 'B' : 'A';
    uiQueueCrossSide(side);
}

function uiScheduleNextCrossAfterDrop(source) {
    if (!ui_crossLoopRunning) return;
    if (ui_monitorHold) return;
    if (ui_loopTimer) clearTimeout(ui_loopTimer);
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    ui_completedLoopCount++;
    ui_timeNoResponseCount = 0;
    var completedSide = ui_crossLoopWaitingSide || ui_crossLoopLastClickedSide || ui_crossLoopLastCompletedSide;
    if (completedSide === 'A' || completedSide === 'B') {
        ui_crossLoopLastCompletedSide = completedSide;
        ui_crossLoopNextSide = uiOtherCrossSide(completedSide);
        ui_crossLoopWaitingSide = '';
        ui_crossLoopResumeSide = '';
        ui_crossLoopTimeoutSide = '';
        ui_crossLoopConsecutiveTimeouts = 0;
        ui_crossLoopLastTimedOutSide = '';
    }
    ui_timeSwitchClickCount++;
    var timeShiftEvery = uiTimeShiftEvery();
    if (ui_timeSwitchClickCount > 0 && ui_timeSwitchClickCount % timeShiftEvery === 0) {
        ui_crossLoopResumeSide = ui_crossLoopNextSide || 'A';
        uiTriggerTimeShift('[跨难度] 时间模式已点击 ' + timeShiftEvery + ' 次，准备调整电脑时间');
        return;
    }
    var delayMs = uiNextAfterDropDelayMs();
    var remaining = Math.ceil(delayMs / 1000);
    var suffix = '（当前已循环 ' + ui_timeSwitchClickCount + ' / ' + timeShiftEvery + ' 次）';
    var replaceKey = 'cross_next_countdown';
    if (remaining > 0) {
        uiStatusReplace(replaceKey, '[跨难度] 已刷新掉落列表：准备下一图，' + remaining + ' 秒后继续' + suffix);
        ui_countdownTimer = setInterval(function() {
            remaining--;
            if (remaining <= 0) {
                clearInterval(ui_countdownTimer);
                ui_countdownTimer = null;
                return;
            }
            uiStatusReplace(replaceKey, '[跨难度] 已刷新掉落列表：准备下一图，' + remaining + ' 秒后继续' + suffix);
        }, 1000);
    }
    ui_loopTimer = setTimeout(function() {
        ui_loopTimer = null;
        if (ui_countdownTimer) clearInterval(ui_countdownTimer);
        ui_countdownTimer = null;
        uiCrossLoopOnce();
    }, delayMs);
}

function uiHandleCrossTimeout(side, index) {
    if (!ui_crossLoopRunning || !ui_waitingForDrop || ui_waitingPressIndex !== index) return;
    side = side === 'B' ? 'B' : 'A';
    ui_timeNoResponseCount++;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_pendingStageLabel = '';
    uiCancelLimitWaitTimers();
    if (ui_crossLoopLastTimedOutSide === side) ui_crossLoopConsecutiveTimeouts++;
    else ui_crossLoopConsecutiveTimeouts = 1;
    ui_crossLoopLastTimedOutSide = side;
    ui_crossLoopTimeoutSide = side;
    ui_crossLoopResumeSide = side;
    if (ui_crossLoopConsecutiveTimeouts >= 2) {
        ui_crossLoopResumeSide = uiOtherCrossSide(side);
        ui_crossLoopConsecutiveTimeouts = 0;
        uiStatus('[跨难度] ' + uiCrossSideName(side) + '关卡重试后仍超时，恢复后改为点击' + uiCrossSideName(ui_crossLoopResumeSide) + '关卡');
    } else {
        uiStatus('[跨难度] 已记录本次超时，恢复后重试' + uiCrossSideName(side) + '关卡');
    }
    ui_crossLoopNextSide = ui_crossLoopResumeSide;
    uiStatus('[跨难度] 等待掉落列表网络响应超过10秒，执行自动修改时间');
    uiTriggerTimeShift('[跨难度] 等待掉落列表网络响应超过10秒，执行自动修改时间');
}

function uiStartCrossLoop() {
    if (ui_crossLoopRunning) return 'already running';
    if (!uiCrossReady()) {
        uiStatus('[跨难度] 请完整录制 A 图和 B 图各 3 项：难度、章节、目标关卡');
        return 'not ready';
    }
    uiStopLoop(true, true);
    ui_crossLoopRunning = true;
    ui_crossLoopNextSide = 'A';
    ui_crossLoopWaitingSide = '';
    ui_crossLoopTimeoutSide = '';
    ui_crossLoopConsecutiveTimeouts = 0;
    ui_crossLoopLastTimedOutSide = '';
    ui_crossLoopResumeSide = '';
    ui_crossLoopLastClickedSide = '';
    ui_crossLoopLastCompletedSide = '';
    uiStatus('[跨难度] 开始循环：A图 ↔ B图');
    uiCrossLoopOnce();
    return 'started';
}

function uiStopCrossLoop(silent, keepAutoDeposit) {
    ui_crossLoopRunning = false;
    if (ui_autoDepositResumeTimer) clearTimeout(ui_autoDepositResumeTimer);
    ui_autoDepositResumeTimer = null;
    ui_crossLoopWaitingSide = '';
    ui_crossLoopTimeoutSide = '';
    ui_crossLoopResumeSide = '';
    ui_crossLoopLastClickedSide = '';
    ui_crossLoopLastCompletedSide = '';
    ui_pendingPresses = [];
    if (!keepAutoDeposit) {
        uiClearAutoDepositTimer();
        ui_autoDepositPendingPresses = [];
        ui_autoDepositRunning = false;
    }
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    if (!silent) uiStatus('[跨难度] 已停止');
    return 'stopped';
}
function uiNormalizeRecordRows(rows) {
    var source = Array.isArray(rows) && rows.length ? rows.slice() : UI_DEFAULT_RECORD_ROWS.slice();
    for (var d = source.length; d < UI_DEFAULT_RECORD_ROWS.length; d++) {
        source.push(UI_DEFAULT_RECORD_ROWS[d]);
    }
    var result = [];
    for (var i = 0; i < source.length; i++) {
        var row = source[i] || {};
        var label = '' + (row.label || ('录制UI #' + (i + 1)));
        var delay = parseFloat(row.delay);
        result.push({
            label: label,
            delay: isNaN(delay) ? 0.1 : Math.max(0, delay)
        });
    }
    return result;
}

function uiSyncRecordMeta() {
    ui_recordRows = uiNormalizeRecordRows((g_config && g_config.record && g_config.record.rows) || ui_recordRows);
    ui_recordLabels = [];
    ui_recordDelays = [];
    for (var i = 0; i < ui_recordRows.length; i++) {
        ui_recordLabels[i] = ui_recordRows[i].label;
        ui_recordDelays[i] = ui_recordRows[i].delay;
    }
}

function uiRecordCount() {
    return ui_recordLabels.length;
}

function uiPressDelayMsForIndex(index) {
    var delay = parseFloat(ui_recordDelays[index]);
    if (!isNaN(delay)) return Math.max(0, Math.round(delay * 1000));
    return uiPressIntervalMs();
}

function uiApplyRecordConfig(configJson) {
    try {
        var data = typeof configJson === 'string' ? JSON.parse(configJson || '{}') : (configJson || {});
        var rows = data.recordRows || (data.record && data.record.rows) || [];
        g_config.record = g_config.record || {};
        g_config.record.rows = uiNormalizeRecordRows(rows);
        uiSyncRecordMeta();
        if (Array.isArray(data.recordedButtons)) {
            uiRestoreRecordedButtons(JSON.stringify({ time: data.recordedButtons }));
        } else {
            uiSaveCurrentRecordSet();
        }
        return 'ok';
    } catch (e) {
        return 'recordconfig failed: ' + e;
    }
}

var UI_REFRESH_WAIT_LOG_MS = 45000;
var UI_DROP_REFRESH_DELAYS = [200, 300, 500, 800, 1200, 1800, 2500, 3500, 5000, 8000, 10000];
var UI_FLOW_WAIT_MAP = 0;
var UI_FLOW_WAIT_FIRST = 1;
var UI_FLOW_WAIT_SECOND = 2;
var UI_FLOW_WAIT_THIRD = 3;
var UI_FLOW_WAIT_FOURTH = 4;
var UI_FLOW_WAIT_FIFTH = 5;
var UI_FLOW_WAIT_SIXTH = 6;
var UI_FLOW_WAIT_SEVENTH = 7;
var UI_FLOW_RUNNING = 8;
var UI_CROSS_START = 11;
var UI_CROSS_SIDE_COUNT = 3;
var UI_CROSS_COUNT = 6;
var UI_DEFAULT_RECORD_ROWS = [
    { label: '低等级箱子关卡', delay: 0.1 },
    { label: '高等级箱子关卡', delay: 0.1 },
    { label: '仓库按钮', delay: 0.4 },
    { label: '放入仓库', delay: 0.4 },
    { label: '仓库1', delay: 0.4 },
    { label: '仓库2', delay: 0.4 },
    { label: '仓库3', delay: 0.4 },
    { label: '仓库4', delay: 0.4 },
    { label: '仓库5', delay: 0.4 },
    { label: '仓库6', delay: 0.4 },
    { label: '仓库7', delay: 0.4 },
    { label: '难度1选择', delay: 0.25 },
    { label: '点击章节', delay: 0.25 },
    { label: '目标关卡', delay: 0.25 },
    { label: '难度2选择', delay: 0.25 },
    { label: '点击章节', delay: 0.25 },
    { label: '目标关卡', delay: 0.25 }
];
var ui_recordRows = [];
var ui_recordLabels = [];
var ui_recordDelays = [];
uiSyncRecordMeta();

var ui_buttonPressPtr = ptr(0);
var ui_buttonPressInfoPtr = ptr(0);
var ui_buttonOnPointerClickPtr = ptr(0);
var ui_buttonOnPointerClickInfoPtr = ptr(0);
var ui_dropdownOnPointerClickPtr = ptr(0);
var ui_dropdownOnPointerClickInfoPtr = ptr(0);
var ui_dropdownShowPtr = ptr(0);
var ui_dropdownShowInfoPtr = ptr(0);
var ui_toggleOnPointerClickPtr = ptr(0);
var ui_toggleOnPointerClickInfoPtr = ptr(0);
var ui_toggleSetIsOnPtr = ptr(0);
var ui_toggleSetIsOnInfoPtr = ptr(0);
var ui_eventSystemUpdatePtr = ptr(0);
var ui_componentGetGameObjectPtr = ptr(0);
var ui_objectGetNamePtr = ptr(0);
var ui_gameObjectGetActiveInHierarchyPtr = ptr(0);
var ui_selectableGetInteractablePtr = ptr(0);
var ui_buttonPress = null;
var ui_buttonOnPointerClick = null;
var ui_dropdownOnPointerClick = null;
var ui_dropdownShow = null;
var ui_toggleOnPointerClick = null;
var ui_toggleSetIsOn = null;
var ui_getGameObject = null;
var ui_getObjectName = null;
var ui_getActiveInHierarchy = null;
var ui_getInteractable = null;
var ui_recorded = [];
var ui_recordedLabels = [];
var ui_recordedKinds = [];
var ui_recordedPoints = [];
var ui_recordedStageInfos = [];
var ui_recordedDifficulties = [];
var ui_recordedKeys = {};
var ui_recordSets = {
    time: { recorded: [], labels: [], kinds: [], points: [], stageInfos: [], difficulties: [] }
};
var ui_stageMap = {};
var ui_lastUIPortal = ptr(0);
var ui_stageNodeByButton = {};
var ui_lastStageScanAt = 0;
var ui_currentStageLabel = '';
var ui_lastClickedStageLabel = '';
var ui_pendingStageLabel = '';
var ui_loopTimer = null;
var ui_loopRunning = false;
var ui_nextIndex = 0;
var ui_completedLoopCount = 0;
var ui_buttonPressMethodInfo = ptr(0);
var ui_pendingPresses = [];
var ui_lastPressAt = 0;
var ui_lastPressIndex = -1;
var ui_flowState = UI_FLOW_WAIT_MAP;
var ui_recordTargetIndex = -1;
var ui_recordStartedPoint = null;
var ui_waitingForDrop = false;
var ui_waitingPressIndex = -1;
var ui_waitBaselineSig = '';
var ui_acceptNextListAsRefresh = false;
var ui_waitTimeoutTimer = null;
var ui_countdownTimer = null;
var ui_monitorHold = false;
var ui_monitorHoldItems = [];
var ui_monitorHoldStage = '';
var ui_monitorHoldExpectedCount = 0;
var ui_monitorHoldDeletedCount = 0;
var ui_monitorHoldExpectedNormal = 0;
var ui_monitorHoldDeletedNormal = 0;
var ui_monitorHoldExpectedBoss = 0;
var ui_monitorHoldDeletedBoss = 0;
var ui_monitorDeploying = false;
var ui_dropRefreshSeq = 0;
var ui_initialized12 = false;
var ui_deployMode = '';
var ui_loopPhase = 'go13';
var ui_firstDeathLoopClick = false;
var ui_lastDropQueues = [];
var ui_lastDropSig = '';
var ui_timeSwitchClickCount = 0;
var ui_waitingTimeShift = false;
var ui_forceTimeNextIndex = -1;
var ui_loopStartTimeIndex = -1;
var ui_lastTimeStageClickIndex = -1;
var ui_sameTimeStageClickCount = 0;
var ui_timeNoResponseCount = 0;
var ui_timeShiftResumeIndex = -1;
var ui_timeShiftLastTimedOutIndex = -1;
var ui_timeShiftConsecutiveTimeouts = 0;
var ui_manualStageSwitchPending = false;
var ui_lastTimeStageSeen = '';
var ui_lastRecordedStageIndex = -1;
var UI_CAPTURE_MODE = 'frida';
var ui_autoOpenEnabled = false;
var ui_autoOpenNormalButton = ptr(0);
var ui_autoOpenBossButton = ptr(0);
var ui_autoOpenRecordKind = '';
var ui_autoOpenAppearDelayMs = 300;
var ui_autoOpenIntervalMs = 500;
var ui_autoOpenLastCheckMs = 0;
var ui_autoOpenLastClickMs = 0;
var ui_autoOpenLastDebugMs = 0;
var ui_autoOpenPendingTimer = null;
var ui_autoOpenPendingButton = ptr(0);
var ui_autoOpenPendingKind = '';
var ui_autoOpenReadyButton = ptr(0);
var ui_autoOpenReadyKind = '';
var ui_autoOpenClickInFlight = false;
var ui_autoOpenLastPointerEvent = ptr(0);
var ui_limitWaitCheckTimer = null;
var ui_limitWaitTimeoutTimer = null;
var ui_lastFrameDrainTickMs = 0;
var ui_lastAutoOpenTickMs = 0;
var ui_autoDepositRunning = false;
var ui_autoDepositPendingPresses = [];
var ui_autoDepositLastRunMs = 0;
var ui_autoDepositTimer = null;
var ui_autoDepositResumeTimer = null;
var ui_crossLoopRunning = false;
var ui_crossLoopNextSide = 'A';
var ui_crossLoopWaitingSide = '';
var ui_crossLoopTimeoutSide = '';
var ui_crossLoopConsecutiveTimeouts = 0;
var ui_crossLoopLastTimedOutSide = '';
var ui_crossLoopResumeSide = '';
var ui_crossLoopLastClickedSide = '';
var ui_crossLoopLastCompletedSide = '';
var UI_FRAME_DRAIN_INTERVAL_MS = 25;
var UI_FRAME_AUTO_OPEN_INTERVAL_MS = 50;

function uiScheduleLoopResumeAfterAutoDeposit() {
    if (ui_autoDepositResumeTimer) clearTimeout(ui_autoDepositResumeTimer);
    ui_autoDepositResumeTimer = setTimeout(function() {
        ui_autoDepositResumeTimer = null;
        if (ui_waitingForDrop || ui_monitorHold || ui_waitingTimeShift) return;
        if (ui_crossLoopRunning) uiCrossLoopOnce();
        else if (ui_loopRunning) uiLoopOnce();
    }, Math.max(80, uiPressIntervalMs()));
}

function uiCancelLimitWaitTimers() {
    if (ui_limitWaitCheckTimer) clearTimeout(ui_limitWaitCheckTimer);
    if (ui_limitWaitTimeoutTimer) clearTimeout(ui_limitWaitTimeoutTimer);
    ui_limitWaitCheckTimer = null;
    ui_limitWaitTimeoutTimer = null;
}

function uiTriggerTimeShift(reason) {
    if (!(ui_loopRunning || ui_crossLoopRunning) || ui_waitingTimeShift) return;
    var waitingIndex = ui_waitingPressIndex;
    var currentStage = uiCurrentStageDisplayName();
    if (ui_crossLoopRunning) ui_forceTimeNextIndex = -1;
    else if (waitingIndex === 0) ui_forceTimeNextIndex = 0;
    else if (waitingIndex === 1) ui_forceTimeNextIndex = 1;
    else ui_forceTimeNextIndex = uiIsHighStage(currentStage) ? 0 : 1;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_pendingStageLabel = '';
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    ui_waitingTimeShift = true;
    uiStatus(reason || '[循环] 时间模式准备调整电脑时间');
    emitEvent('time_shift_cycle', {
        minutes: 15,
        restoreDelayMs: uiTimeShiftRestoreMs(),
        continueDelayMs: uiTimeShiftContinueMs()
    });
    uiCancelLimitWaitTimers();
}

function uiFindMethod(ns, klassName, methodName, argCount) {
    for (var i = 0; i < cnt; i++) {
        var asm = asms.add(i * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var img = aif(asm);
        if (!img || img.isNull()) continue;
        var klass = cfn(img, cstr(ns), cstr(klassName));
        if (!klass || klass.isNull()) continue;
        var m = cmfn(klass, cstr(methodName), argCount);
        if (m && !m.isNull()) return m.readPointer();
    }
    return ptr(0);
}

function uiFindMethodInfo(ns, klassName, methodName, argCount) {
    for (var i = 0; i < cnt; i++) {
        var asm = asms.add(i * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var img = aif(asm);
        if (!img || img.isNull()) continue;
        var klass = cfn(img, cstr(ns), cstr(klassName));
        if (!klass || klass.isNull()) continue;
        var m = cmfn(klass, cstr(methodName), argCount);
        if (m && !m.isNull()) return m;
    }
    return ptr(0);
}

function uiDifficultyName(difficulty) {
    difficulty = parseInt(difficulty, 10);
    if (difficulty === 0) return '普通';
    if (difficulty === 1) return '噩梦';
    if (difficulty === 2) return '地狱';
    if (difficulty === 3) return '折磨';
    return '难度' + difficulty;
}

function uiParseDifficultyName(text) {
    text = '' + (text || '');
    if (text.indexOf('普通') >= 0) return 0;
    if (text.indexOf('噩梦') >= 0) return 1;
    if (text.indexOf('地狱') >= 0) return 2;
    if (text.indexOf('折磨') >= 0) return 3;
    return null;
}

function uiCallPortalRefreshNoArg(key) {
    var methodInfo = uiFindMethodInfo('TaskbarHero.UI', 'UI_Portal', key, 0);
    if (!methodInfo || methodInfo.isNull()) return null;
    var fp = methodPtr(methodInfo);
    if (!fp || fp.isNull()) return null;
    try {
        var retName = '';
        try { retName = readStr(tgn(mgrt(methodInfo))); } catch (e0) {}
        var ret = retName.indexOf('Void') !== -1 ? 'void' : 'int';
        var fn = new NativeFunction(fp, ret, ['pointer']);
        if (ret === 'void') fn(ui_lastUIPortal);
        else fn(ui_lastUIPortal);
        return { ok: true, key: key };
    } catch (e) {
        return { ok: false, key: key, message: '' + e };
    }
}

function uiSwitchPortalDifficulty(difficulty) {
    difficulty = parseInt(difficulty, 10);
    if (isNaN(difficulty) || difficulty < 0 || difficulty > 3) {
        uiStatus('[跨难度] 难度值无效：' + difficulty);
        return false;
    }
    if (!ui_lastUIPortal || ui_lastUIPortal.isNull() || !uiIsReadable(ui_lastUIPortal)) {
        uiStatus('[跨难度] 尚未捕获关卡面板实例，请先打开一次关卡页面');
        return false;
    }
    var offset = found['UI_Portal.m_currentStageDifficulty'];
    if (typeof offset !== 'number' || offset < 0) {
        uiStatus('[跨难度] 没有找到 UI_Portal.m_currentStageDifficulty 字段');
        return false;
    }
    try {
        var field = ui_lastUIPortal.add(offset);
        field.writeS32(difficulty);
        var actual = field.readS32();
        if (actual !== difficulty) {
            uiStatus('[跨难度] 难度写入失败：期望 ' + uiDifficultyName(difficulty) + '，实际 ' + uiDifficultyName(actual));
            return false;
        }
    } catch (e) {
        uiStatus('[跨难度] 写入难度失败：' + e);
        return false;
    }
    var methods = ['lqe', 'lqw', 'lqx'];
    for (var i = 0; i < methods.length; i++) {
        var refresh = uiCallPortalRefreshNoArg(methods[i]);
        if (refresh && refresh.ok) {
            uiStatus('[跨难度] 已切换难度：' + uiDifficultyName(difficulty));
            return true;
        }
    }
    uiStatus('[跨难度] 已写入难度：' + uiDifficultyName(difficulty) + '，但未找到刷新入口');
    return true;
}

function uiHookUIPortalInstanceDiscovery() {
    var hooked = 0;
    for (var ai = 0; ai < cnt; ai++) {
        var asm = asms.add(ai * Process.pointerSize).readPointer();
        if (!asm || asm.isNull()) continue;
        var img = aif(asm);
        if (!img || img.isNull()) continue;
        var klass = cfn(img, cstr('TaskbarHero.UI'), cstr('UI_Portal'));
        if (!klass || klass.isNull()) continue;
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        while (hooked < 80) {
            var method = cgm(klass, iter);
            if (!method || method.isNull()) break;
            var name = readStr(mgn(method));
            if (!name || name === '.ctor' || name === '.cctor') continue;
            var fp = ptr(0);
            try { fp = method.readPointer(); } catch (e0) { fp = ptr(0); }
            if (!fp || fp.isNull()) continue;
            (function(methodName, methodPtr) {
                try {
                    Interceptor.attach(methodPtr, {
                        onEnter: function(args) {
                            if (!args[0] || args[0].isNull() || !uiIsReadable(args[0])) return;
                            ui_lastUIPortal = args[0];
                        }
                    });
                    hooked++;
                } catch (e) {}
            })(name, fp);
        }
        break;
    }
    log('[跨难度] UI_Portal实例捕获Hook数量=' + hooked);
    return hooked;
}

function uiIl2cppString(strObj) {
    try {
        if (!strObj || strObj.isNull()) return '';
        var len = strObj.add(0x10).readS32();
        if (len <= 0 || len > 512) return '';
        return strObj.add(0x14).readUtf16String(len);
    } catch (e) {
        return '';
    }
}

function uiIsReadable(p) {
    try {
        var r = Process.findRangeByAddress(p);
        return !!(r && r.protection.indexOf('r') !== -1);
    } catch (e) {
        return false;
    }
}

function uiObjectName(componentOrObject) {
    if (!componentOrObject || componentOrObject.isNull()) return '';
    try {
        var obj = componentOrObject;
        if (ui_getGameObject) {
            var go = ui_getGameObject(componentOrObject);
            if (go && !go.isNull()) obj = go;
        }
        if (ui_getObjectName) return uiIl2cppString(ui_getObjectName(obj));
    } catch (e) {}
    return '';
}

function uiPtrFromString(value) {
    try {
        if (!value) return ptr(0);
        var p = ptr('' + value);
        return p && !p.isNull() ? p : ptr(0);
    } catch (e) {
        return ptr(0);
    }
}

function uiReadPointerField(instance, key, fallback) {
    try {
        if (!instance || instance.isNull() || !uiIsReadable(instance)) return ptr(0);
        var offset = (typeof found[key] === 'number') ? found[key] : fallback;
        if (typeof offset !== 'number' || offset < 0) return ptr(0);
        var value = instance.add(offset).readPointer();
        return value && !value.isNull() ? value : ptr(0);
    } catch (e) {
        return ptr(0);
    }
}

function uiReadS32Field(instance, key, fallback) {
    try {
        if (!instance || instance.isNull() || !uiIsReadable(instance)) return 0;
        var offset = (typeof found[key] === 'number') ? found[key] : fallback;
        if (typeof offset !== 'number' || offset < 0) return 0;
        return instance.add(offset).readS32();
    } catch (e) {
        return 0;
    }
}

function uiStageMapKey(level, difficulty) {
    level = parseInt(level || '0', 10) || 0;
    difficulty = parseInt(difficulty || '0', 10) || 0;
    return String(difficulty) + ':' + String(level);
}

function uiStageLabel(info) {
    if (!info) return '';
    var difficulty = parseInt(info.difficulty || '0', 10) || 0;
    var names = ['普通', '噩梦', '地狱', '折磨'];
    return (names[difficulty] || ('难度' + difficulty)) + ' 等级' + info.level;
}

function uiSameStageInfo(a, b) {
    if (!a || !b) return false;
    return (parseInt(a.level || '0', 10) || 0) === (parseInt(b.level || '0', 10) || 0) &&
        (parseInt(a.difficulty || '0', 10) || 0) === (parseInt(b.difficulty || '0', 10) || 0);
}

function uiSerializeStageInfo(info) {
    if (!info) return null;
    return {
        stageKey: info.stageKey || 0,
        difficulty: info.difficulty || 0,
        act: info.act || 0,
        stageNo: info.stageNo || 0,
        level: info.level || 0,
        nodePtr: info.nodePtr && !info.nodePtr.isNull ? info.nodePtr.toString() : (info.nodePtr || ''),
        buttonPtr: info.buttonPtr && !info.buttonPtr.isNull ? info.buttonPtr.toString() : (info.buttonPtr || '')
    };
}

function uiHydrateStageInfo(info) {
    if (!info) return null;
    var copy = {
        stageKey: parseInt(info.stageKey || '0', 10) || 0,
        difficulty: parseInt(info.difficulty || '0', 10) || 0,
        act: parseInt(info.act || '0', 10) || 0,
        stageNo: parseInt(info.stageNo || '0', 10) || 0,
        level: parseInt(info.level || '0', 10) || 0,
        nodePtr: uiPtrFromString(info.nodePtr || ''),
        buttonPtr: uiPtrFromString(info.buttonPtr || '')
    };
    if (copy.level > 0) ui_stageMap[uiStageMapKey(copy.level, copy.difficulty)] = copy;
    if (copy.buttonPtr && !copy.buttonPtr.isNull()) ui_stageNodeByButton[copy.buttonPtr.toString()] = copy;
    return copy;
}

function uiCacheStageNodeInfo(nodePtr, source) {
    try {
        if (!nodePtr || nodePtr.isNull() || !uiIsReadable(nodePtr)) return null;
        var cachePtr = uiReadPointerField(nodePtr, 'StageNode.bdcv', 0x58);
        var stageInfoPtr = uiReadPointerField(cachePtr, 'StageCache.betl', 0x10);
        if (!stageInfoPtr || stageInfoPtr.isNull()) return null;
        var stageKey = uiReadS32Field(stageInfoPtr, 'StageInfoData.StageKey', 0x30);
        var difficulty = uiReadS32Field(stageInfoPtr, 'StageInfoData.STAGEDIFFICULTY', 0x44);
        var act = uiReadS32Field(stageInfoPtr, 'StageInfoData.Act', 0x48);
        var stageNo = uiReadS32Field(stageInfoPtr, 'StageInfoData.StageNo', 0x4c);
        var level = uiReadS32Field(stageInfoPtr, 'StageInfoData.StageLevel', 0x50);
        if (level <= 0 || level > 300 || stageKey <= 0) return null;
        difficulty = Math.max(0, parseInt(difficulty || '0', 10) || 0);
        var buttonPtr = uiReadPointerField(nodePtr, 'StageNode.button_Enter', 0x40);
        var info = {
            stageKey: stageKey,
            difficulty: difficulty,
            act: act,
            stageNo: stageNo,
            level: level,
            nodePtr: nodePtr,
            buttonPtr: buttonPtr,
            source: source || ''
        };
        ui_stageMap[uiStageMapKey(level, difficulty)] = info;
        if (buttonPtr && !buttonPtr.isNull()) ui_stageNodeByButton[buttonPtr.toString()] = info;
        return info;
    } catch (e) {
        return null;
    }
}

function uiScanStageNodeList(listPtr, source) {
    var count = 0;
    try {
        if (!listPtr || listPtr.isNull() || !uiIsReadable(listPtr)) return 0;
        var arr = listPtr.add(0x10).readPointer();
        var size = listPtr.add(0x18).readS32();
        if (!arr || arr.isNull() || size <= 0 || size > 512) return 0;
        for (var i = 0; i < size; i++) {
            var node = arr.add(0x20 + i * Process.pointerSize).readPointer();
            if (uiCacheStageNodeInfo(node, (source || 'stage-list') + '#' + i)) count++;
        }
    } catch (e) {}
    return count;
}

function uiScanPortalStageMaps(source) {
    var total = 0;
    try {
        if (!ui_lastUIPortal || ui_lastUIPortal.isNull() || !uiIsReadable(ui_lastUIPortal)) return 0;
        var nowMs = Date.now();
        if (source !== 'record-target' && source !== 'cross-stage-replay' && nowMs - ui_lastStageScanAt < 2000) return 0;
        ui_lastStageScanAt = nowMs;
        ui_stageNodeByButton = {};
        if (source === 'record-target' || source === 'cross-stage-replay') ui_stageMap = {};
        total += uiScanStageNodeList(uiReadPointerField(ui_lastUIPortal, 'UI_Portal.bfzh', 0x198), (source || 'UI_Portal') + '.bfzh');
        total += uiScanStageNodeList(uiReadPointerField(ui_lastUIPortal, 'UI_Portal.bfzi', 0x1a0), (source || 'UI_Portal') + '.bfzi');
        if (total > 0) uiStatusThrottled('cross_stage_scan', '[跨难度] 已扫描关卡节点 ' + total + ' 个', 5000);
    } catch (e) {}
    return total;
}

function uiButtonAlive(button) {
    if (!button || button.isNull()) return false;
    if (!uiIsReadable(button)) return false;
    var name = uiObjectName(button);
    if (!name) return false;
    try {
        if (ui_getInteractable && !ui_getInteractable(button)) return false;
    } catch (e) {
        return false;
    }
    try {
        if (ui_getGameObject && ui_getActiveInHierarchy) {
            var go = ui_getGameObject(button);
            if (!go || go.isNull()) return false;
            if (!ui_getActiveInHierarchy(go)) return false;
        }
    } catch (e) {
        return false;
    }
    return true;
}

var ui_getCursorPos = null;
var ui_cursorPoint = null;

function uiCurrentCursorPoint() {
    try {
        if (!ui_getCursorPos) ui_getCursorPos = new NativeFunction(Process.getModuleByName('user32.dll').getExportByName('GetCursorPos'), 'bool', ['pointer']);
        if (!ui_cursorPoint) ui_cursorPoint = Memory.alloc(8);
        if (ui_getCursorPos(ui_cursorPoint)) {
            return { x: ui_cursorPoint.readS32(), y: ui_cursorPoint.add(4).readS32() };
        }
    } catch (e) {}
    return { x: -1, y: -1 };
}

var ui_setCursorPos = null;
var ui_mouseEvent = null;

function uiClickScreenPoint(point, label) {
    try {
        if (!point) return false;
        var x = parseInt(point.x, 10);
        var y = parseInt(point.y, 10);
        if (isNaN(x) || isNaN(y) || x < 0 || y < 0) return false;
        var user32 = Process.getModuleByName('user32.dll');
        if (!ui_setCursorPos) ui_setCursorPos = new NativeFunction(user32.getExportByName('SetCursorPos'), 'bool', ['int', 'int']);
        if (!ui_mouseEvent) ui_mouseEvent = new NativeFunction(user32.getExportByName('mouse_event'), 'void', ['uint', 'uint', 'uint', 'uint', 'pointer']);
        var oldPoint = uiCurrentCursorPoint();
        ui_setCursorPos(x, y);
        Thread.sleep(0.03);
        ui_mouseEvent(0x0002, 0, 0, 0, ptr(0));
        Thread.sleep(0.04);
        ui_mouseEvent(0x0004, 0, 0, 0, ptr(0));
        if (oldPoint && oldPoint.x >= 0 && oldPoint.y >= 0) ui_setCursorPos(oldPoint.x, oldPoint.y);
        uiStatus('[点击] ' + label + '（坐标 ' + x + ',' + y + '）');
        return true;
    } catch (e) {
        uiStatus('[点击] 坐标点击失败：' + e);
        return false;
    }
}

function uiScheduleAutoOpenClick(button, kind) {
    if (!button || button.isNull()) return;
    var nowMs = Date.now();
    if (nowMs - ui_autoOpenLastClickMs < Math.max(100, ui_autoOpenIntervalMs)) return;
    if (ui_autoOpenPendingTimer) return;
    ui_autoOpenPendingButton = button;
    ui_autoOpenPendingKind = kind === 'boss' ? 'boss' : 'normal';
    ui_autoOpenPendingTimer = setTimeout(function() {
        ui_autoOpenPendingTimer = null;
        var target = ui_autoOpenPendingButton;
        var pendingKind = ui_autoOpenPendingKind;
        ui_autoOpenPendingButton = ptr(0);
        ui_autoOpenPendingKind = '';
        if (!ui_autoOpenEnabled || !uiButtonAlive(target)) return;
        ui_autoOpenReadyButton = target;
        ui_autoOpenReadyKind = pendingKind === 'boss' ? 'boss' : 'normal';
        uiStatus('[自动开箱] 已排队主线程点击：' + (ui_autoOpenReadyKind === 'boss' ? '首领箱' : '普通箱'));
    }, Math.max(0, ui_autoOpenAppearDelayMs));
}

function uiCancelAutoOpenPending() {
    if (ui_autoOpenPendingTimer) clearTimeout(ui_autoOpenPendingTimer);
    ui_autoOpenPendingTimer = null;
    ui_autoOpenPendingButton = ptr(0);
    ui_autoOpenPendingKind = '';
    ui_autoOpenReadyButton = ptr(0);
    ui_autoOpenReadyKind = '';
    ui_autoOpenClickInFlight = false;
}

function uiAutoOpenTick() {
    if (!ui_autoOpenEnabled) return;
    var nowMs = Date.now();
    if (ui_autoOpenClickInFlight) return;
    if (ui_autoOpenReadyButton && !ui_autoOpenReadyButton.isNull()) {
        var readyButton = ui_autoOpenReadyButton;
        var readyKind = ui_autoOpenReadyKind;
        ui_autoOpenReadyButton = ptr(0);
        ui_autoOpenReadyKind = '';
        if (uiButtonAlive(readyButton)) {
            ui_autoOpenLastClickMs = nowMs;
            ui_autoOpenClickInFlight = true;
            uiStatus('[自动开箱] 请求真实点击：' + (readyKind === 'boss' ? '首领箱' : '普通箱'));
            emitEvent('auto_open_click', { kind: readyKind });
        }
        return;
    }
    if (nowMs - ui_autoOpenLastCheckMs < Math.max(100, ui_autoOpenIntervalMs)) return;
    ui_autoOpenLastCheckMs = nowMs;
    if (uiButtonAlive(ui_autoOpenBossButton)) {
        uiScheduleAutoOpenClick(ui_autoOpenBossButton, 'boss');
        return;
    }
    if (uiButtonAlive(ui_autoOpenNormalButton)) {
        uiScheduleAutoOpenClick(ui_autoOpenNormalButton, 'normal');
        return;
    }
    if (nowMs - ui_autoOpenLastDebugMs > 10000) {
        ui_autoOpenLastDebugMs = nowMs;
    }
}

function uiPromptMapReady() {
    uiStatus('请先打开地图界面，完成后点击控制面板里的“地图已打开”');
}

function uiPromptFirstClick() {
    uiStatus('请点击' + (ui_recordLabels[0] || '录制UI #1'));
}

function uiPromptSecondClick() {
    uiStatus('请点击' + (ui_recordLabels[1] || '录制UI #2'));
}

function uiPromptRecordIndex(index) {
    if (index >= 0 && index < uiRecordCount()) {
        uiStatus('请点击' + (ui_recordLabels[index] || ('录制UI #' + (index + 1))));
    }
}

function uiIsDeployMode() {
    if (uiRecordCount() <= 0) return false;
    for (var i = 0; i < uiRecordCount(); i++) {
        if (!ui_recorded[i]) return false;
    }
    return true;
}

function uiClearRecordedOnly() {
    ui_recorded = [];
    ui_recordedLabels = [];
    ui_recordedKinds = [];
    ui_recordedPoints = [];
    ui_recordedStageInfos = [];
    ui_recordedDifficulties = [];
    ui_recordedKeys = {};
    uiSaveCurrentRecordSet();
    ui_currentStageLabel = '';
    ui_lastClickedStageLabel = '';
    ui_pendingStageLabel = '';
    ui_nextIndex = 0;
    ui_completedLoopCount = 0;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
        ui_monitorHold = false;
        ui_monitorHoldItems = [];
        ui_monitorHoldStage = '';
        ui_monitorHoldExpectedCount = 0;
        ui_monitorHoldDeletedCount = 0;
        ui_monitorHoldExpectedNormal = 0;
        ui_monitorHoldDeletedNormal = 0;
        ui_monitorHoldExpectedBoss = 0;
        ui_monitorHoldDeletedBoss = 0;
        ui_monitorDeploying = false;
    ui_initialized12 = false;
    ui_deployMode = '';
    ui_loopPhase = 'go13';
    ui_lastDropQueues = [];
    ui_lastDropSig = '';
    ui_timeSwitchClickCount = 0;
    ui_waitingTimeShift = false;
    ui_lastTimeStageClickIndex = -1;
    ui_loopStartTimeIndex = -1;
    ui_sameTimeStageClickCount = 0;
    ui_timeShiftResumeIndex = -1;
    ui_timeShiftLastTimedOutIndex = -1;
    ui_timeShiftConsecutiveTimeouts = 0;
    ui_crossLoopConsecutiveTimeouts = 0;
    ui_crossLoopLastTimedOutSide = '';
    ui_crossLoopTimeoutSide = '';
    ui_crossLoopResumeSide = '';
    ui_crossLoopLastClickedSide = '';
    ui_crossLoopLastCompletedSide = '';
    ui_manualStageSwitchPending = false;
    ui_lastTimeStageSeen = '';
    ui_lastRecordedStageIndex = -1;
    ui_recordTargetIndex = -1;
    ui_dropRefreshSeq++;
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    uiCancelLimitWaitTimers();
}

function uiRecordButtonAtIndex(button, index, label) {
    return uiRecordObjectAtIndex(button, index, label, 'button');
}

function uiRecordPointAtIndex(point, index, label) {
    if (!point) return;
    var x = parseInt(point.x, 10);
    var y = parseInt(point.y, 10);
    if (isNaN(x) || isNaN(y) || x < 0 || y < 0) return;
    var fakePtr = ptr('0x' + (0x70000000 + index).toString(16));
    ui_recorded[index] = fakePtr;
    ui_recordedLabels[index] = label;
    ui_recordedKinds[index] = 'point';
    ui_recordedPoints[index] = { x: x, y: y };
    ui_recordedStageInfos[index] = null;
    ui_recordedDifficulties[index] = null;
    ui_lastRecordedStageIndex = index;
    uiSaveCurrentRecordSet();
    uiStatus('[录制] #' + (index + 1) + ' ' + label + ' 完成（坐标 ' + x + ',' + y + '）');
}

function uiRecordObjectAtIndex(button, index, label, kind) {
    if (!button || button.isNull()) return;
    kind = kind || 'button';
    var stageInfo = null;
    ui_recorded[index] = button;
    ui_recordedLabels[index] = label;
    ui_recordedKinds[index] = kind;
    ui_recordedPoints[index] = null;
    ui_recordedStageInfos[index] = stageInfo;
    ui_recordedDifficulties[index] = null;
    ui_recordedKeys[button.toString()] = true;
    ui_lastRecordedStageIndex = index;
    if (index === 0) ui_currentStageLabel = ui_recordLabels[0] || '录制UI #1';
    if (index === 1) ui_currentStageLabel = ui_recordLabels[1] || '录制UI #2';
    if (index === 0) ui_lastTimeStageSeen = ui_recordLabels[0] || '录制UI #1';
    if (index === 1) ui_lastTimeStageSeen = ui_recordLabels[1] || '录制UI #2';
    uiSaveCurrentRecordSet();
    uiStatus('[录制] #' + (index + 1) + ' ' + label + ' 完成' + (kind !== 'button' ? '（' + (kind === 'stage' ? uiStageLabel(stageInfo) : kind) + '）' : ''));
}

function uiRecordDifficultyAtIndex(button, index, label, difficulty) {
    if (!button || button.isNull()) return;
    ui_recorded[index] = button;
    ui_recordedLabels[index] = label;
    ui_recordedKinds[index] = 'difficulty';
    ui_recordedPoints[index] = null;
    ui_recordedStageInfos[index] = null;
    ui_recordedDifficulties[index] = difficulty;
    ui_recordedKeys[button.toString()] = true;
    ui_lastRecordedStageIndex = index;
    uiSaveCurrentRecordSet();
    uiStatus('[录制] #' + (index + 1) + ' ' + label + ' 完成（难度 ' + uiDifficultyName(difficulty) + '）');
}

function uiClearRecordButtonAtIndex(index) {
    index = parseInt(index, 10);
    if (isNaN(index) || index < 0 || index >= uiRecordCount()) return 'invalid index';
    var old = ui_recorded[index];
    if (old) delete ui_recordedKeys[old.toString()];
    ui_recorded[index] = null;
    ui_recordedLabels[index] = '';
    if (ui_lastRecordedStageIndex === index) {
        ui_lastRecordedStageIndex = -1;
        for (var i = uiRecordCount() - 1; i >= 0; i--) {
            if (ui_recorded[i]) {
                ui_lastRecordedStageIndex = i;
                break;
            }
        }
    }
    uiSyncRecordedStagePreference();
    uiSaveCurrentRecordSet();
    uiStatus('[录制] #' + (index + 1) + ' 已清空');
    return 'ok';
}

function uiClearAutoOpenButton(kind) {
    kind = kind === 'boss' ? 'boss' : 'normal';
    if (kind === 'boss') {
        ui_autoOpenBossButton = ptr(0);
        uiStatus('[自动开箱] 首领箱按钮已清空');
    } else {
        ui_autoOpenNormalButton = ptr(0);
        uiStatus('[自动开箱] 普通箱按钮已清空');
    }
    ui_autoOpenPendingButton = ptr(0);
    ui_autoOpenPendingKind = '';
    ui_autoOpenReadyButton = ptr(0);
    ui_autoOpenReadyKind = '';
    ui_autoOpenClickInFlight = false;
    return 'ok';
}

function uiRestoreRecordedButtons(recordedJson) {
    var restored = 0;
    try {
        var raw = JSON.parse(recordedJson || '[]');
        if (!raw) return 'empty';
        var sets = Array.isArray(raw) ? { time: raw } : raw;
        var arr = Array.isArray(sets.time) ? sets.time : [];
        ui_recordSets.time = { recorded: [], labels: [], kinds: [], points: [], stageInfos: [], difficulties: [] };
        ui_lastRecordedStageIndex = -1;
        for (var i = 0; i < uiRecordCount(); i++) {
            var row = arr[i] || null;
            if (!row || !row.ptr) continue;
            var p = ptr(row.ptr);
            if (!p || p.isNull()) continue;
        ui_recordSets.time.recorded[i] = p;
        ui_recordSets.time.labels[i] = row.label || ui_recordLabels[i] || '';
        ui_recordSets.time.kinds[i] = row.kind || 'button';
        ui_recordSets.time.points[i] = row.point || null;
        ui_recordSets.time.stageInfos[i] = row.stageInfo ? uiSerializeStageInfo(uiHydrateStageInfo(row.stageInfo)) : null;
        ui_recordSets.time.difficulties[i] = row.difficulty == null ? null : parseInt(row.difficulty, 10);
        ui_lastRecordedStageIndex = i;
        restored++;
        }
        uiUseRecordSet(uiSwitchMode());
        if (ui_recorded[0]) ui_currentStageLabel = ui_recordLabels[0] || '录制UI #1';
        if (ui_recorded[1]) ui_currentStageLabel = ui_recordLabels[1] || '录制UI #2';
        uiSyncRecordedStagePreference();
        if (uiAllRecorded()) {
            ui_flowState = UI_FLOW_RUNNING;
            ui_recordTargetIndex = -1;
            uiStatus('[录制] 已恢复上次录制按钮，可以开始循环');
        }
        return 'restored ' + restored;
    } catch (e) {
        return 'restore failed: ' + e;
    }
}

function uiStageButtonsRecorded() {
    return !!(ui_recorded[0] && ui_recorded[1]);
}

function uiAllRecorded() {
    return uiStageButtonsRecorded();
}

function uiAfterRangerDeployed() {
    ui_monitorDeploying = false;
    ui_deployMode = '';
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    if (uiEnterMonitorHoldFromQueues(ui_lastDropQueues, '游侠已上场')) return;
    ui_monitorHold = false;
    ui_monitorHoldItems = [];
    ui_loopPhase = 'go13';
    uiStatus('[循环] 游侠已上场，当前列表无监控物品，准备前往高等级关卡');
    uiScheduleNextAfterDrop('游侠检查');
}

function uiEnterMonitorHoldFromQueues(queues, reason) {
    var watched = watchedItemsInQueues(queues);
    if (watched.length <= 0) return false;
    var normalExpected = 0;
    var bossExpected = 0;
    for (var wi = 0; wi < watched.length; wi++) {
        var w = watched[wi] || {};
        var queueLabel = '' + (w.queueLabel || '');
        if (queueLabel.indexOf('首领') >= 0 || queueLabel.toLowerCase().indexOf('boss') >= 0) bossExpected++;
        else normalExpected++;
    }
    ui_monitorHold = true;
    ui_monitorHoldItems = watched;
    ui_monitorHoldStage = uiCurrentStageDisplayName() || reason || '';
    ui_monitorHoldExpectedCount = watched.length;
    ui_monitorHoldDeletedCount = 0;
    ui_monitorHoldExpectedNormal = normalExpected;
    ui_monitorHoldDeletedNormal = 0;
    ui_monitorHoldExpectedBoss = bossExpected;
    ui_monitorHoldDeletedBoss = 0;
    ui_monitorDeploying = false;
    ui_deployMode = '';
    ui_loopPhase = 'wait_drop';
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_pendingPresses = [];
    if (ui_loopTimer) clearTimeout(ui_loopTimer);
    ui_loopTimer = null;
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    var holdPrefix = ui_crossLoopRunning ? '[跨难度]' : '[循环]';
    uiStatus(holdPrefix + ' 掉落列表发现监控物品，停止点击，等待列表内无监控物品：' + watchedItemsText(watched) + (reason ? '（' + reason + '）' : ''));
    emitWatchDetected(reason || '掉落列表', watched);
    return true;
}

function uiSetRecordTarget(index) {
    index = parseInt(index, 10);
    if (isNaN(index) || index < 0 || index >= uiRecordCount()) return 'invalid index';
    var old = ui_recorded[index];
    if (old) delete ui_recordedKeys[old.toString()];
    ui_recorded[index] = null;
    ui_recordedLabels[index] = '';
    ui_recordedKinds[index] = '';
    ui_recordedPoints[index] = null;
    ui_recordedStageInfos[index] = null;
    ui_recordedDifficulties[index] = null;
    uiSaveCurrentRecordSet();
    ui_recordTargetIndex = index;
    ui_recordStartedPoint = uiCurrentCursorPoint();
    ui_flowState = UI_FLOW_RUNNING;
    uiStatus('[录制] 请在游戏里点击：' + (ui_recordLabels[index] || ('录制UI #' + (index + 1))));
    return '请在游戏里点击：' + (ui_recordLabels[index] || ('录制UI #' + (index + 1)));
}

function uiDoPressButton(button, label) {
    if (!button || button.isNull() || !uiIsReadable(button)) {
        uiStatus('[点击] 按钮指针失效：' + button);
        return false;
    }
    if (!ui_buttonPressMethodInfo || ui_buttonPressMethodInfo.isNull()) {
        uiStatus('[点击] 缺少 Button.Press MethodInfo');
        return false;
    }

    try {
        uiStatus('[点击] ' + label);
        ui_buttonPress(button, ui_buttonPressMethodInfo);
        return true;
    } catch (e) {
        uiStatus('[点击] 失败：' + e);
        return false;
    }
}

function uiDoReplayRecorded(index, label) {
    var target = ui_recorded[index];
    var kind = ui_recordedKinds[index] || 'button';
    if (kind === 'difficulty') {
        return uiSwitchPortalDifficulty(ui_recordedDifficulties[index]);
    }
    if (kind === 'stage') {
        var info = ui_recordedStageInfos[index] || null;
        if (info) {
            uiScanPortalStageMaps('cross-stage-replay');
            var live = ui_stageMap[uiStageMapKey(info.level, info.difficulty)] || info;
            if (live && live.buttonPtr && !live.buttonPtr.isNull()) {
                var checked = live.nodePtr && !live.nodePtr.isNull ? uiCacheStageNodeInfo(live.nodePtr, 'cross-stage-live-check') : null;
                if (checked && !uiSameStageInfo(checked, info)) {
                    uiStatus('[跨难度] 内部切图已取消：按钮节点已变成 ' + uiStageLabel(checked) + '，目标是 ' + uiStageLabel(info));
                    return false;
                }
                ui_recorded[index] = live.buttonPtr;
                ui_recordedStageInfos[index] = live;
                uiStatus('[跨难度] 内部切图：' + uiStageLabel(live));
                return uiDoPressButton(live.buttonPtr, label);
            }
        }
        uiStatus('[跨难度] 内部切图失败，未找到目标关卡节点：' + uiStageLabel(info));
        return false;
    }
    if (!target || target.isNull() || !uiIsReadable(target)) {
        uiStatus('[点击] 指针失效：' + target);
        return false;
    }
    if (kind === 'dropdown') {
        if (ui_dropdownShow && ui_dropdownShowInfoPtr && !ui_dropdownShowInfoPtr.isNull()) {
            try {
                ui_dropdownShow(target, ui_dropdownShowInfoPtr);
                return true;
            } catch (e) {
                uiStatus('[点击] Dropdown.Show 失败：' + e);
            }
        }
        if (ui_dropdownOnPointerClick && ui_autoOpenLastPointerEvent && !ui_autoOpenLastPointerEvent.isNull() &&
            ui_dropdownOnPointerClickInfoPtr && !ui_dropdownOnPointerClickInfoPtr.isNull()) {
            try {
                ui_dropdownOnPointerClick(target, ui_autoOpenLastPointerEvent, ui_dropdownOnPointerClickInfoPtr);
                return true;
            } catch (e2) {
                uiStatus('[点击] Dropdown.PointerClick 失败：' + e2);
            }
        }
        return false;
    }
    if (kind === 'toggle') {
        if (ui_toggleSetIsOn && ui_toggleSetIsOnInfoPtr && !ui_toggleSetIsOnInfoPtr.isNull()) {
            try {
                ui_toggleSetIsOn(target, 1, ui_toggleSetIsOnInfoPtr);
                return true;
            } catch (e3) {
                uiStatus('[点击] Toggle.set_isOn 失败：' + e3);
            }
        }
        if (ui_toggleOnPointerClick && ui_autoOpenLastPointerEvent && !ui_autoOpenLastPointerEvent.isNull() &&
            ui_toggleOnPointerClickInfoPtr && !ui_toggleOnPointerClickInfoPtr.isNull()) {
            try {
                ui_toggleOnPointerClick(target, ui_autoOpenLastPointerEvent, ui_toggleOnPointerClickInfoPtr);
                return true;
            } catch (e4) {
                uiStatus('[点击] Toggle.PointerClick 失败：' + e4);
            }
        }
        return false;
    }
    return uiDoPressButton(target, label);
}

function uiQueuePressIndex(index) {
    if (ui_monitorHold) {
        uiStatusThrottled('monitor_hold_block_queue', (ui_crossLoopRunning ? '[跨难度]' : '[循环]') + ' 已发现监控物品，停止后续点击：' + watchedItemsText(ui_monitorHoldItems), 2000);
        return false;
    }
    if (!ui_recorded[index]) {
        uiStatus('[点击] 尚未录制按钮 #' + (index + 1));
        return false;
    }
    if (index < 0 || index >= ui_recorded.length) return false;
    ui_pendingPresses.push(index);
    uiStatus('[队列] 已加入 #' + (index + 1));
    return true;
}

function uiPressIndexNow(index) {
    index = parseInt(index, 10);
    if (isNaN(index) || index < 0 || index >= ui_recorded.length) return false;
    if (ui_monitorHold) {
        uiStatusThrottled('monitor_hold_block_press', (ui_crossLoopRunning ? '[跨难度]' : '[循环]') + ' 已发现监控物品，停止后续点击：' + watchedItemsText(ui_monitorHoldItems), 2000);
        return false;
    }
    if (!ui_recorded[index]) {
        uiStatus('[点击] 尚未录制按钮 #' + (index + 1));
        return false;
    }
    ui_pendingPresses = [index];
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    uiCancelLimitWaitTimers();
    uiStatus('[队列] 立即执行 #' + (index + 1));
    uiDrainPressQueue();
    return true;
}

function uiDoClickButton(button, label) {
    if (!button || button.isNull() || !uiIsReadable(button)) {
        uiStatus('[点击] 按钮指针失效：' + button);
        return false;
    }

    uiStatus('[点击] ' + label);
    if (ui_buttonOnPointerClick && ui_autoOpenLastPointerEvent && !ui_autoOpenLastPointerEvent.isNull() &&
        ui_buttonOnPointerClickInfoPtr && !ui_buttonOnPointerClickInfoPtr.isNull()) {
        try {
            ui_buttonOnPointerClick(button, ui_autoOpenLastPointerEvent, ui_buttonOnPointerClickInfoPtr);
            uiStatus('[自动开箱] 已触发 PointerClick：' + label);
            return true;
        } catch (e) {
            uiStatus('[自动开箱] PointerClick 失败，尝试 Press：' + e);
        }
    }

    return uiDoPressButton(button, label);
}

function uiWaitText(target) {
    return '等待' + target + '网络响应';
}

function uiScheduleMemoryRefresh(source, baselineSig) {
    if (UI_CAPTURE_MODE === 'frida') return;
    var seq = ++g_refreshSeq;
    var delays = [500, 1000, 1800, 3000, 5000, 8000, 12000, 20000, 30000];
    for (var i = 0; i < delays.length; i++) {
        (function(delay, isLast) {
            setTimeout(function() {
                if (seq !== g_refreshSeq) return;
                if (scanResponseMemoryOnce(source || '内存响应', baselineSig || '', true)) return;
                var queues = readBexlQueues('memory-wait');
                if (queues.length === 0) {
                    if (isLast && ui_loopRunning && ui_waitingForDrop) uiStatusThrottled('memory_wait_empty', '[循环] 仍在等待内存掉落列表刷新', 5000);
                    return;
                }
                var sig = queueSignature(queues);
                if (!baselineSig || sig !== baselineSig) {
                    showBexlQueues(source || '刷新', true);
                } else if (isLast && ui_loopRunning && ui_waitingForDrop) {
                    uiStatusThrottled('memory_wait_same', '[循环] 内存掉落列表还未变化，继续等待', 5000);
                }
            }, delay);
        })(delays[i], i === delays.length - 1);
    }
}

function uiDrainPressQueue() {
    var usingDepositQueue = ui_autoDepositRunning && ui_autoDepositPendingPresses.length > 0;
    if (!usingDepositQueue && ui_pendingPresses.length === 0) return;
    var nowMs = Date.now();
    var neededDelay = uiPressIntervalMs();
    if (ui_lastPressIndex >= 0 && ui_lastPressIndex < uiRecordCount()) {
        neededDelay = uiPressDelayMsForIndex(ui_lastPressIndex);
    }
    if (ui_deployMode === 'monitor' && (ui_lastPressIndex === 3 || ui_lastPressIndex === 4 || ui_lastPressIndex === 6)) {
        neededDelay = uiRoleDeployDelayMs();
    }
    if (ui_lastPressAt && nowMs - ui_lastPressAt < neededDelay) return;
    var pressEntry = usingDepositQueue ? ui_autoDepositPendingPresses.shift() : ui_pendingPresses.shift();
    var isDepositPress = false;
    var isCrossPress = false;
    var isCrossFinal = false;
    var crossSide = '';
    var i = pressEntry;
    if (pressEntry && typeof pressEntry === 'object') {
        i = parseInt(pressEntry.index, 10);
        isDepositPress = pressEntry.deposit === true;
        isCrossPress = pressEntry.cross === true;
        isCrossFinal = pressEntry.final === true;
        crossSide = pressEntry.side || '';
    }
    var beforeSig = '';
    var stageLabel = ui_recordedLabels[i] || ('#' + (i + 1));
    var ok = uiDoReplayRecorded(i, stageLabel);
    if (ok) {
        ui_lastPressAt = nowMs;
        ui_lastPressIndex = i;
    }
    if (isDepositPress) {
        if (!ok) uiStatus('[\u81ea\u52a8\u5165\u5e93] \u70b9\u51fb\u5931\u8d25\uff1a' + stageLabel);
        if (ui_autoDepositPendingPresses.length === 0 || !ok) {
            ui_autoDepositRunning = false;
            ui_autoDepositPendingPresses = [];
            uiStatus(ok ? '[\u81ea\u52a8\u5165\u5e93] \u5df2\u5b8c\u6210' : '[\u81ea\u52a8\u5165\u5e93] \u5df2\u505c\u6b62');
            if (ok) {
                uiScheduleAutoDepositTimer(uiAutoDepositIntervalMs());
                uiScheduleLoopResumeAfterAutoDeposit();
            }
        }
        return;
    }
    if (isCrossPress) {
        if (!ok) {
            ui_crossLoopRunning = false;
            uiStatus('[跨难度] 点击失败：' + stageLabel);
            return;
        }
        if (!isCrossFinal) {
            uiStatus('[跨难度] 已点击：' + stageLabel);
            return;
        }
        if (crossSide === 'A' || crossSide === 'B') {
            ui_crossLoopLastClickedSide = crossSide;
            ui_crossLoopWaitingSide = crossSide;
        }
        ui_lastClickedStageLabel = stageLabel;
        ui_pendingStageLabel = stageLabel;
        ui_waitingForDrop = true;
        ui_waitingPressIndex = i;
        ui_waitBaselineSig = beforeSig;
        ui_acceptNextListAsRefresh = true;
        uiCancelLimitWaitTimers();
        if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
        ui_waitTimeoutTimer = setTimeout(function() {
            uiHandleCrossTimeout(crossSide, i);
        }, 10000);
        uiStatus('[跨难度] ' + uiCrossSideName(crossSide) + '目标关卡已点击，' + uiWaitText('掉落列表'));
        return;
    }
    if (ok && ui_loopRunning) {
        ui_lastClickedStageLabel = stageLabel;
        if (i < uiRecordCount()) {
            ui_pendingStageLabel = stageLabel;
            ui_waitingForDrop = true;
            ui_waitingPressIndex = i;
            ui_waitBaselineSig = beforeSig;
            ui_acceptNextListAsRefresh = true;
            uiCancelLimitWaitTimers();
            if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
            if (uiSwitchMode() === 'time') {
                ui_waitTimeoutTimer = setTimeout(function() {
                    if (!ui_loopRunning || !ui_waitingForDrop || ui_waitingPressIndex !== i) return;
                    ui_timeNoResponseCount++;
                    ui_waitingForDrop = false;
                    ui_waitingPressIndex = -1;
                    ui_waitBaselineSig = '';
                    ui_acceptNextListAsRefresh = false;
                    ui_pendingStageLabel = '';
                    uiCancelLimitWaitTimers();
                    if (uiAutoTimeShiftOnLimitEnabled()) {
                        if (ui_timeShiftLastTimedOutIndex === i) ui_timeShiftConsecutiveTimeouts++;
                        else ui_timeShiftConsecutiveTimeouts = 1;
                        ui_timeShiftLastTimedOutIndex = i;
                        ui_timeShiftResumeIndex = i;
                        if (ui_timeShiftConsecutiveTimeouts >= 2) {
                            ui_timeShiftResumeIndex = i === 0 ? 1 : 0;
                            ui_timeShiftConsecutiveTimeouts = 0;
                            uiStatus('[循环] 时间模式：' + uiTimeStageNameByIndex(i) + ' 重试后仍超时，恢复后改为点击' + uiTimeStageNameByIndex(ui_timeShiftResumeIndex));
                        } else {
                            uiStatus('[循环] 时间模式：已记录本次超时，恢复后重试' + uiTimeStageNameByIndex(i));
                        }
                        uiStatus('[循环] 时间模式等待网络响应超过10秒，执行自动修改时间');
                        uiTriggerTimeShift('[循环] 时间模式等待网络响应超过10秒，执行自动修改时间');
                        return;
                    }
                    var nextIndex = i;
                    if (ui_timeNoResponseCount >= 2) {
                        nextIndex = i === 0 ? 1 : 0;
                        ui_timeNoResponseCount = 0;
                        uiStatus('[循环] 时间模式连续2次无响应，下一次改为点击' + uiTimeStageNameByIndex(nextIndex));
                    }
                    uiStatus('[循环] 时间模式等待网络响应超过10秒，本次结束等待');
                    uiScheduleTimeNoResponseDelay(nextIndex, UI_TIME_NO_RESPONSE_DELAY_MS);
                }, 10000);
            } else {
                ui_waitTimeoutTimer = setTimeout(function() {
                    if (ui_loopRunning && ui_waitingForDrop) {
                        uiStatus('[循环] 仍在等待' + stageLabel + '刷新');
                    }
                }, UI_REFRESH_WAIT_LOG_MS);
            }
            uiStatus('[循环] ' + stageLabel + '，' + uiWaitText('掉落列表'));
        } else if (i === 5) {
            if (ui_deployMode === 'monitor' || (ui_monitorHold && ui_monitorDeploying)) {
                uiStatus('[循环] 游侠替换上场，检测当前掉落列表');
                uiAfterRangerDeployed();
            } else {
                ui_pendingStageLabel = '低等级关卡';
                ui_waitingForDrop = true;
                ui_waitingPressIndex = i;
                ui_waitBaselineSig = beforeSig;
                ui_acceptNextListAsRefresh = true;
                ui_deployMode = '';
                if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
                ui_waitTimeoutTimer = setTimeout(function() {
                    if (ui_loopRunning && ui_waitingForDrop) {
                        uiStatus('[循环] 已执行替换上场，等待死亡回到低等级关卡刷新');
                    }
                }, UI_REFRESH_WAIT_LOG_MS);
                uiStatus('[循环] 替换上场，' + uiWaitText('低等级关卡'));
            }
        }
    }
}

function uiLoopOnce() {
    if (!ui_loopRunning) {
        uiStatusThrottled('loop_not_running', '[调试] uiLoopOnce return: ui_loopRunning=false', 5000);
        return;
    }
    if (ui_monitorHold) {
        uiStatusThrottled('loop_monitor_hold', '[循环] 监控物品等待掉落中，暂不点击高等级关卡：' + watchedItemsText(ui_monitorHoldItems), 3000);
        return;
    }
    if (ui_waitingForDrop) {
        uiStatusThrottled('loop_waiting_debug', '[调试] uiLoopOnce return: waitingForDrop=true waitingIndex=' + ui_waitingPressIndex + ' pending=' + ui_pendingPresses.length, 5000);
        uiStatusThrottled('loop_waiting_drop', '[循环] 正在等待掉落列表刷新，暂不点击下一关', 2000);
        return;
    }
    if (ui_pendingPresses.length > 0) {
        uiStatusThrottled('loop_pending_press', '[调试] uiLoopOnce return: pendingPresses=' + ui_pendingPresses.length, 3000);
        return;
    }
    if (ui_waitingTimeShift) {
        uiStatusThrottled('loop_waiting_timeshift', '[调试] uiLoopOnce return: waitingTimeShift=true', 3000);
        return;
    }
    if (uiSwitchMode() === 'time') {
        if (!ui_recorded[0] || !ui_recorded[1]) {
            uiStatus('[循环] 时间模式需要先录制：' + (ui_recordLabels[0] || '录制UI #1') + '、' + (ui_recordLabels[1] || '录制UI #2'));
            return;
        }
        var timeStage = uiCurrentStageDisplayName();
        var targetIndex = -1;
        if (ui_forceTimeNextIndex >= 0) targetIndex = ui_forceTimeNextIndex;
        else if (ui_loopStartTimeIndex >= 0) targetIndex = ui_loopStartTimeIndex;
        else targetIndex = uiNextTimeIndexFromStage(timeStage || ui_lastTimeStageSeen || '');
        if (ui_lastTimeStageClickIndex === targetIndex) ui_sameTimeStageClickCount++;
        else ui_sameTimeStageClickCount = 1;
        if (ui_sameTimeStageClickCount >= 3) {
            targetIndex = uiOtherTimeStageIndex(targetIndex);
            ui_sameTimeStageClickCount = 1;
            uiStatus('[循环] 防卡死：连续检测到同一等级关卡3次，改为前往' + uiTimeStageNameByIndex(targetIndex));
        }
        ui_lastTimeStageClickIndex = targetIndex;
        ui_forceTimeNextIndex = -1;
        ui_loopStartTimeIndex = -1;
        ui_loopPhase = targetIndex === 0 ? 'go12_time' : 'go13_time';
        uiStatus(uiTimeLoopLogByIndex(targetIndex));
        uiQueuePressIndex(targetIndex);
        return;
    }
    if (!uiIsDeployMode()) {
        uiStatus('[循环] 等待录制7个按钮，当前=' + ui_recorded.length);
        return;
    }
    if (ui_firstDeathLoopClick) {
        ui_firstDeathLoopClick = false;
        ui_loopPhase = 'go13';
        uiStatus('[循环] 前往高等级关卡');
        uiQueuePressIndex(1);
        return;
    }
    var stage = uiCurrentStageDisplayName();
    if (uiIsHighStage(stage)) {
        ui_loopPhase = 'return12';
        uiStatus('[循环] 前往低等级关卡');
        uiQueuePressIndex(0);
        return;
    }
    ui_loopPhase = 'go13';
    uiStatus('[循环] 前往高等级关卡');
    uiQueuePressIndex(1);
}

function uiStartLoop() {
    if (ui_loopRunning) return 'already running';
    uiStopCrossLoop(true, true);
    ui_loopRunning = true;
    ui_completedLoopCount = 0;
    ui_timeSwitchClickCount = 0;
    ui_lastTimeStageClickIndex = -1;
    ui_sameTimeStageClickCount = 0;
    uiSyncRecordedStagePreference();
    ui_loopStartTimeIndex = uiSwitchMode() === 'time' ? uiLoopStartTimeIndexFromRecorded() : -1;
    ui_waitingTimeShift = false;
    ui_timeShiftResumeIndex = -1;
    ui_timeShiftLastTimedOutIndex = -1;
    ui_timeShiftConsecutiveTimeouts = 0;
    ui_manualStageSwitchPending = false;
    ui_loopPhase = 'go13';
    ui_firstDeathLoopClick = uiSwitchMode() !== 'time';
    uiStatus(uiSwitchMode() === 'time' ? '[循环] 开始：时间模式 低等级关卡 ↔ 高等级关卡' : '[循环] 开始：前往高等级关卡 → 送死回低等级关卡 → 游侠检查 → 延迟后继续');
    if (ui_waitingForDrop) {
        uiStatus('[循环] 当前已在等待掉落列表刷新，刷新后开始下一次点击');
    } else {
        uiLoopOnce();
    }
    return 'started';
}

function uiStopLoop(silent, keepAutoDeposit) {
    if (ui_loopTimer) clearInterval(ui_loopTimer);
    ui_loopTimer = null;
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    ui_loopRunning = false;
    ui_crossLoopRunning = false;
    if (ui_autoDepositResumeTimer) clearTimeout(ui_autoDepositResumeTimer);
    ui_autoDepositResumeTimer = null;
    ui_crossLoopWaitingSide = '';
    if (!keepAutoDeposit) {
        uiClearAutoDepositTimer();
        ui_autoDepositRunning = false;
        ui_autoDepositPendingPresses = [];
    }
    ui_completedLoopCount = 0;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_monitorHold = false;
    ui_monitorHoldItems = [];
    ui_monitorHoldStage = '';
    ui_monitorHoldExpectedCount = 0;
    ui_monitorHoldDeletedCount = 0;
    ui_monitorDeploying = false;
    ui_deployMode = '';
    ui_pendingPresses = [];
    ui_waitingTimeShift = false;
    ui_loopStartTimeIndex = -1;
    ui_lastTimeStageClickIndex = -1;
    ui_sameTimeStageClickCount = 0;
    ui_timeShiftResumeIndex = -1;
    ui_timeShiftLastTimedOutIndex = -1;
    ui_timeShiftConsecutiveTimeouts = 0;
    ui_manualStageSwitchPending = false;
    ui_lastTimeStageSeen = '';
    ui_firstDeathLoopClick = false;
    ui_dropRefreshSeq++;
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    uiCancelLimitWaitTimers();
    if (!silent) {
        uiStatus('[循环] 已停止');
    }
    return 'stopped';
}

function uiScheduleNextAfterDrop(source) {
    if (!ui_loopRunning) return;
    if (ui_monitorHold) return;
    if (ui_loopTimer) clearTimeout(ui_loopTimer);
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    ui_completedLoopCount++;
    ui_timeNoResponseCount = 0;
    if (uiSwitchMode() === 'time') {
        ui_timeSwitchClickCount++;
        var timeShiftEvery = uiTimeShiftEvery();
        if (ui_timeSwitchClickCount > 0 && ui_timeSwitchClickCount % timeShiftEvery === 0) {
            uiTriggerTimeShift('[循环] 时间模式已点击 ' + timeShiftEvery + ' 次，准备调整电脑时间');
            return;
        }
    }
    var baseDelayMs = uiNextAfterDropDelayMs();
    var extraDelayMs = uiSwitchMode() === 'time' ? 0 : uiLoopPauseExtraDelayMs();
    var delayMs = baseDelayMs + extraDelayMs;
    var remaining = Math.ceil(delayMs / 1000);
    var countSuffix = uiSwitchMode() === 'time' ? '（当前已循环 ' + ui_timeSwitchClickCount + ' / ' + uiTimeShiftEvery() + ' 次）' : '';
    var pauseSuffix = extraDelayMs > 0 ? '（已循环 ' + ui_completedLoopCount + ' 次，额外暂停 ' + Math.ceil(extraDelayMs / 1000) + ' 秒）' : countSuffix;
    if (remaining > 0) {
        uiStatus('[循环] 已刷新掉落列表：准备下一次点击，' + remaining + ' 秒后继续' + pauseSuffix);
        ui_countdownTimer = setInterval(function() {
            remaining--;
            if (remaining <= 0) {
                clearInterval(ui_countdownTimer);
                ui_countdownTimer = null;
                return;
            }
            uiStatus('[循环] 已刷新掉落列表：准备下一次点击，' + remaining + ' 秒后继续' + pauseSuffix);
        }, 1000);
    }
    ui_loopTimer = setTimeout(function() {
        ui_loopTimer = null;
        if (ui_countdownTimer) clearInterval(ui_countdownTimer);
        ui_countdownTimer = null;
        uiLoopOnce();
    }, delayMs);
}

function uiNextAfterDropDelaySecondsText() {
    var seconds = uiNextAfterDropDelayMs() / 1000;
    return seconds % 1 === 0 ? '' + seconds : seconds.toFixed(1).replace(/0+$/, '').replace(/\.$/, '');
}

function uiScheduleTimeNoResponseDelay(nextIndex, delayMs) {
    if (!ui_loopRunning) return;
    if (ui_loopTimer) clearTimeout(ui_loopTimer);
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    ui_forceTimeNextIndex = nextIndex;
    var remaining = Math.ceil(delayMs / 1000);
    uiStatus('[循环] 时间模式未勾选自动修改时间，' + remaining + ' 秒后继续点击' + uiTimeStageNameByIndex(nextIndex));
    if (remaining > 1) {
        ui_countdownTimer = setInterval(function() {
            remaining--;
            if (remaining <= 0) {
                clearInterval(ui_countdownTimer);
                ui_countdownTimer = null;
                return;
            }
            uiStatus('[循环] 时间模式未勾选自动修改时间，' + remaining + ' 秒后继续点击' + uiTimeStageNameByIndex(nextIndex));
        }, 1000);
    }
    ui_loopTimer = setTimeout(function() {
        ui_loopTimer = null;
        if (ui_countdownTimer) clearInterval(ui_countdownTimer);
        ui_countdownTimer = null;
        uiLoopOnce();
    }, delayMs);
}

function uiContinueAfterTimeShift() {
    ui_waitingTimeShift = false;
    if (!(ui_loopRunning || ui_crossLoopRunning)) return 'not running';
    ui_timeSwitchClickCount = 0;
    ui_timeNoResponseCount = 0;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_pendingStageLabel = '';
    uiCancelLimitWaitTimers();
    if (ui_crossLoopRunning) {
        if (ui_crossLoopResumeSide === 'A' || ui_crossLoopResumeSide === 'B') {
            ui_crossLoopNextSide = ui_crossLoopResumeSide;
            uiStatus('[跨难度] 时间已恢复，改时间计数已归0，继续点击' + uiCrossSideName(ui_crossLoopResumeSide) + '关卡');
            ui_crossLoopResumeSide = '';
        } else {
            uiStatus('[跨难度] 时间已恢复，改时间计数已归0，继续点击');
        }
        uiCrossLoopOnce();
        return 'continued';
    }
    if (ui_timeShiftResumeIndex >= 0) {
        ui_forceTimeNextIndex = ui_timeShiftResumeIndex;
        uiStatus('[循环] 时间已恢复，改时间计数已归0，继续点击' + uiTimeStageNameByIndex(ui_timeShiftResumeIndex));
        ui_timeShiftResumeIndex = -1;
    } else {
        uiStatus('[循环] 时间已恢复，改时间计数已归0，继续点击');
    }
    uiLoopOnce();
    return 'continued';
}

function uiResetTimeWaitState() {
    ui_waitingTimeShift = false;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_pendingStageLabel = '';
    ui_pendingPresses = [];
    ui_autoDepositPendingPresses = [];
    ui_autoDepositRunning = false;
    uiClearAutoDepositTimer();
    if (ui_autoDepositResumeTimer) clearTimeout(ui_autoDepositResumeTimer);
    ui_autoDepositResumeTimer = null;
    ui_timeShiftResumeIndex = -1;
    ui_timeShiftLastTimedOutIndex = -1;
    ui_timeShiftConsecutiveTimeouts = 0;
    ui_crossLoopTimeoutSide = '';
    ui_crossLoopConsecutiveTimeouts = 0;
    ui_crossLoopLastTimedOutSide = '';
    ui_crossLoopResumeSide = '';
    ui_crossLoopLastClickedSide = '';
    ui_crossLoopLastCompletedSide = '';
    uiCancelLimitWaitTimers();
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
}

function uiPrepareDetach(silent) {
    uiStopLoop(true);
    uiResetTimeWaitState();
    uiCancelAutoOpenPending();
    ui_autoOpenEnabled = false;
    ui_autoOpenRecordKind = '';
    ui_autoOpenLastPointerEvent = ptr(0);
    ui_autoOpenLastCheckMs = 0;
    ui_autoOpenLastClickMs = 0;
    ui_autoOpenLastDebugMs = 0;
    if (!silent) uiStatus('[连接] 脚本已停止，准备断开');
    return 'prepared';
}

function uiConfirmStageFromList(source) {
    if (ui_pendingStageLabel) {
        ui_currentStageLabel = ui_pendingStageLabel;
        ui_lastTimeStageSeen = ui_pendingStageLabel;
        ui_pendingStageLabel = '';
        uiStatus('[关卡] 当前识别：' + ui_currentStageLabel);
    }
}

function uiRecordedIndexByButton(button) {
    if (!button || button.isNull()) return -1;
    var key = button.toString();
    for (var i = 0; i < ui_recorded.length; i++) {
        if (ui_recorded[i] && ui_recorded[i].toString() === key) return i;
    }
    return -1;
}

function uiFindRecordedStageByButton(button) {
    var idx = uiRecordedIndexByButton(button);
    if (idx < 0) return '';
    return ui_recordedLabels[idx] || ('#' + (idx + 1));
}

function uiSyncNextIndexAfterManualClick(button) {
    var idx = uiRecordedIndexByButton(button);
    if (idx < 0 || ui_recorded.length < 2) return;
    ui_manualStageSwitchPending = true;
    ui_nextIndex = (idx + 1) % ui_recorded.length;
    if (idx === 0 || idx === 1) {
        ui_forceTimeNextIndex = idx === 0 ? 1 : 0;
        ui_lastTimeStageClickIndex = idx;
        ui_sameTimeStageClickCount = 0;
    }
}

function uiOnDropQueuesShown(source, queues, sig) {
    if (!(ui_loopRunning || ui_crossLoopRunning) || !ui_waitingForDrop) return;
    var isNetworkSource = ('' + (source || '')).indexOf('网络') >= 0 || ('' + (source || '')).toLowerCase().indexOf('network') >= 0;
    var refreshed = isNetworkSource || ui_acceptNextListAsRefresh || !ui_waitBaselineSig || sig !== ui_waitBaselineSig;
    if (!refreshed) return;
    var completedPressIndex = ui_waitingPressIndex;
    ui_waitingForDrop = false;
    uiCancelLimitWaitTimers();
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_waitingPressIndex = -1;
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    ui_timeShiftResumeIndex = -1;
    ui_timeShiftLastTimedOutIndex = -1;
    ui_timeShiftConsecutiveTimeouts = 0;
    var stageName = uiCurrentStageDisplayName();
    if (!stageName && completedPressIndex === 0) stageName = '低等级关卡';
    if (!stageName && completedPressIndex === 1) stageName = '高等级关卡';
    if (!stageName && completedPressIndex === 5) stageName = '低等级关卡';
    uiLogNextDropSummary(stageName, queues);
    if (ui_crossLoopRunning) {
        if (uiEnterMonitorHoldFromQueues(queues, stageName || source || '列表刷新')) return;
        uiScheduleNextCrossAfterDrop(source);
        return;
    }
    if (uiIsLowStage(stageName)) {
        if (uiSwitchMode() === 'time') {
            if (uiEnterMonitorHoldFromQueues(queues, stageName || source || '列表刷新')) return;
            uiScheduleNextAfterDrop(source);
            return;
        }
        ui_initialized12 = true;
        if (uiEnterMonitorHoldFromQueues(queues, stageName || source || '列表刷新')) return;
        ui_loopPhase = 'go13';
        uiScheduleNextAfterDrop(source);
        return;
    }
    if (uiEnterMonitorHoldFromQueues(queues, stageName || source || '列表刷新')) return;
    if (uiIsDeployMode() && uiIsHighStage(stageName)) {
        if (uiSwitchMode() === 'time') {
            uiScheduleNextAfterDrop(source);
            return;
        }
        ui_loopPhase = 'return12';
        uiQueuePressIndex(0);
        return;
    }
    uiScheduleNextAfterDrop(source);
}

function uiOnNetworkDropQueues(source, queuePayload, currentStage) {
    var payloadRoot = null;
    if (queuePayload && !Array.isArray(queuePayload) && typeof queuePayload === 'object') {
        payloadRoot = queuePayload;
        queuePayload = queuePayload.queues || [];
        if (!currentStage) currentStage = payloadRoot.currentStage || '';
    }
    var queues = [];
    if (queuePayload && queuePayload.length) {
        for (var qi = 0; qi < queuePayload.length; qi++) {
            var q = queuePayload[qi] || {};
            var eboxType = parseInt(q.eboxType, 10) || 0;
            var items = [];
            if (q.items && q.items.length) {
                for (var ii = 0; ii < q.items.length; ii++) {
                    var item = q.items[ii];
                    var id = item && typeof item === 'object' ? item.id : item;
                    var parsed = parseInt(id, 10);
                    if (!isNaN(parsed)) {
                        if (item && typeof item === 'object') {
                            items.push({
                                id: parsed,
                                name: item.name || '',
                                grade: item.grade || '',
                                gradeKey: item.gradeKey || '',
                                itemKey: item.itemKey || '',
                                rewardItemKey: item.rewardItemKey || '',
                                key: item.key || '',
                                watched: !!item.watched
                            });
                        } else {
                            items.push(parsed);
                        }
                    }
                }
            }
            queues.push({
                eboxType: eboxType,
                label: q.label || (eboxType === 1 ? '首领掉落' : '普通掉落'),
                items: items,
                size: items.length
            });
        }
    }
    if (queues.length === 0) return false;
    var sig = queueSignature(queues);
    ui_lastDropQueues = queues;
    ui_lastDropSig = sig;
    if (payloadRoot && payloadRoot.monitorProgress) {
        ui_monitorHoldExpectedCount = Math.max(0, parseInt(payloadRoot.monitorProgress.expected, 10) || 0);
        ui_monitorHoldDeletedCount = Math.max(0, parseInt(payloadRoot.monitorProgress.deleted, 10) || 0);
        ui_monitorHoldExpectedNormal = Math.max(0, parseInt(payloadRoot.monitorProgress.normalExpected, 10) || 0);
        ui_monitorHoldDeletedNormal = Math.max(0, parseInt(payloadRoot.monitorProgress.normalDeleted, 10) || 0);
        ui_monitorHoldExpectedBoss = Math.max(0, parseInt(payloadRoot.monitorProgress.bossExpected, 10) || 0);
        ui_monitorHoldDeletedBoss = Math.max(0, parseInt(payloadRoot.monitorProgress.bossDeleted, 10) || 0);
    }
    var beforeStage = uiCurrentStageDisplayName();
    if (currentStage) {
        ui_currentStageLabel = currentStage;
        ui_lastTimeStageSeen = currentStage;
        ui_pendingStageLabel = '';
    }
    uiConfirmStageFromList(source || '网络/箱子');
    if ((ui_loopRunning || ui_crossLoopRunning) && ui_monitorHold) {
        var stillWatched = watchedItemsInQueues(queues);
        if (stillWatched.length > 0) {
            ui_monitorHoldItems = stillWatched;
            if (!ui_monitorHoldStage) ui_monitorHoldStage = beforeStage || currentStage || '';
            var waitingDeleteNeed = Math.max(0, ui_monitorHoldExpectedCount - ui_monitorHoldDeletedCount);
            if (waitingDeleteNeed > 0) {
                uiStatusThrottled('monitor_hold_still_watched', '[循环] 当前列表仍有监控物品，继续等待实际开箱：' + watchedItemsText(stillWatched) + '（已删除 ' + monitorHoldProgressText() + '）', 2000);
            } else if (ui_crossLoopRunning) {
                uiStatusThrottled('cross_monitor_hold_visible', '[跨难度] 当前列表仍有监控物品，继续等待列表刷新：' + watchedItemsText(stillWatched), 2000);
            }
            return true;
        }
        if (ui_manualStageSwitchPending) {
            ui_manualStageSwitchPending = false;
            ui_monitorHold = false;
            ui_monitorHoldItems = [];
            ui_monitorHoldStage = '';
            ui_monitorHoldExpectedCount = 0;
            ui_monitorHoldDeletedCount = 0;
            ui_monitorHoldExpectedNormal = 0;
            ui_monitorHoldDeletedNormal = 0;
            ui_monitorHoldExpectedBoss = 0;
            ui_monitorHoldDeletedBoss = 0;
            ui_monitorDeploying = false;
            ui_deployMode = '';
            uiStatus('[循环] 手动切关后已刷新掉落列表，结束本次等待并继续流程');
        } else
        if (ui_monitorHoldDeletedCount < ui_monitorHoldExpectedCount) {
            uiStatusThrottled('monitor_hold_progress_wait', '[循环] 监控物品已从当前显示列表消失，但删除进度未完成，继续等待：' + monitorHoldProgressText(), 3000);
            return true;
        }
        var holdStage = currentStage || uiCurrentStageDisplayName() || ui_monitorHoldStage || beforeStage || '';
        ui_monitorHold = false;
        ui_monitorHoldItems = [];
        ui_monitorHoldStage = '';
        ui_monitorHoldExpectedCount = 0;
        ui_monitorHoldDeletedCount = 0;
        ui_monitorHoldExpectedNormal = 0;
        ui_monitorHoldDeletedNormal = 0;
        ui_monitorHoldExpectedBoss = 0;
        ui_monitorHoldDeletedBoss = 0;
        ui_monitorDeploying = false;
        ui_deployMode = '';
        ui_waitingForDrop = false;
        ui_waitingPressIndex = -1;
        ui_waitBaselineSig = '';
        ui_acceptNextListAsRefresh = false;
        if (ui_loopTimer) clearTimeout(ui_loopTimer);
        ui_loopTimer = null;
        if (ui_countdownTimer) clearInterval(ui_countdownTimer);
        ui_countdownTimer = null;
        if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
        ui_waitTimeoutTimer = null;
        uiStatus('[循环] 当前掉落列表已无监控物品，继续流程');
        if (ui_crossLoopRunning) {
            uiScheduleNextCrossAfterDrop(source || '监控列表刷新');
            return true;
        }
        if (uiSwitchMode() === 'time') {
            uiScheduleNextAfterDrop(source || '监控列表刷新');
            return true;
        }
        if (uiIsLowStage(holdStage)) {
            ui_loopPhase = 'go13';
            uiScheduleNextAfterDrop(source || '监控列表刷新');
            return true;
        }
        if (uiIsDeployMode() && uiIsHighStage(holdStage)) {
            ui_loopPhase = 'return12';
            uiStatus('[循环] 前往低等级关卡');
            uiQueuePressIndex(0);
            return true;
        }
        uiScheduleNextAfterDrop(source || '监控列表刷新');
        return true;
    }
    if ((ui_loopRunning || ui_crossLoopRunning) && !ui_monitorHold && uiEnterMonitorHoldFromQueues(queues, currentStage || source || '网络响应')) {
        return true;
    }
    uiOnDropQueuesShown(source || '网络响应', queues, sig);
    return true;
}

function uiOnItemDropped(itemId, source, forceWatched) {
    if (!forceWatched && !isWatchedItem(itemId)) return;
    if (source !== 'Hook掉落') {
        uiStatus('[掉落] 监控物品已掉落(' + source + ')：' + itemLabel(itemId, true));
    }
    ui_monitorHoldDeletedCount += 1;
    if (('' + itemId).indexOf('920') === 0) ui_monitorHoldDeletedBoss += 1;
    else ui_monitorHoldDeletedNormal += 1;
    if (!(ui_loopRunning || ui_crossLoopRunning)) return;
    if (!ui_monitorHold) return;
    if (ui_monitorHold && ui_monitorHoldItems.length > 0) {
        removeDroppedFromMonitorHold(itemId);
        if (ui_monitorHoldItems.length > 0) {
            uiStatusThrottled('item_dropped_hold_remaining', (ui_crossLoopRunning ? '[跨难度]' : '[循环]') + ' 当前列表仍有监控物品，继续等待实际开箱：' + watchedItemsText(ui_monitorHoldItems) + '（已删除 ' + monitorHoldProgressText() + '）', 2000);
            return;
        }
    }
    if (ui_monitorHold && watchedItemsInQueues(ui_lastDropQueues).length > 0) {
        uiStatusThrottled('item_dropped_visible_remaining', (ui_crossLoopRunning ? '[跨难度]' : '[循环]') + ' 当前显示列表仍有监控物品，继续等待列表刷新', 3000);
        return;
    }
    if (ui_monitorHold && ui_monitorHoldDeletedCount < ui_monitorHoldExpectedCount) {
        uiStatusThrottled('item_dropped_progress_wait', (ui_crossLoopRunning ? '[跨难度]' : '[循环]') + ' 删除进度未完成，继续等待：' + monitorHoldProgressText(), 3000);
        return;
    }
    ui_monitorHold = false;
    ui_monitorHoldItems = [];
    ui_monitorHoldStage = '';
    ui_monitorHoldExpectedCount = 0;
    ui_monitorHoldDeletedCount = 0;
    ui_monitorHoldExpectedNormal = 0;
    ui_monitorHoldDeletedNormal = 0;
    ui_monitorHoldExpectedBoss = 0;
    ui_monitorHoldDeletedBoss = 0;
    ui_monitorDeploying = false;
    ui_waitingForDrop = false;
    ui_waitingPressIndex = -1;
    ui_waitBaselineSig = '';
    ui_acceptNextListAsRefresh = false;
    ui_pendingPresses = [];
    ui_loopPhase = 'return12';
    if (ui_loopTimer) clearTimeout(ui_loopTimer);
    ui_loopTimer = null;
    if (ui_countdownTimer) clearInterval(ui_countdownTimer);
    ui_countdownTimer = null;
    if (ui_waitTimeoutTimer) clearTimeout(ui_waitTimeoutTimer);
    ui_waitTimeoutTimer = null;
    if (ui_crossLoopRunning) {
        uiScheduleNextCrossAfterDrop(source || '实际开箱');
        return;
    }
    uiStatus('[循环] 前往低等级关卡');
    if (uiSwitchMode() === 'time') {
        uiScheduleNextAfterDrop(source || '实际开箱');
        return;
    }
    uiQueuePressIndex(0);
}

function uiReady() {
    var wasRunning = ui_flowState === UI_FLOW_RUNNING || (ui_pendingPresses && ui_pendingPresses.length > 0);
    uiStopLoop(true);
    ui_pendingPresses = [];
    ui_autoDepositPendingPresses = [];
    ui_autoDepositRunning = false;
    ui_flowState = UI_FLOW_RUNNING;
    ui_recordTargetIndex = -1;
    return 'ready';
}

function initUiReplay() {
    for (var metaScan = 0; metaScan < cnt; metaScan++) {
        var asmMeta = asms.add(metaScan * Process.pointerSize).readPointer();
        if (!asmMeta || asmMeta.isNull()) continue;
        var imgMeta = aif(asmMeta);
        if (!imgMeta || imgMeta.isNull()) continue;
        findFieldOffset(imgMeta, 'TaskbarHero', 'StageNode', 'bdcv', 'StageNode.bdcv');
        findFieldOffset(imgMeta, 'TaskbarHero', 'StageNode', 'button_Enter', 'StageNode.button_Enter');
        findFieldOffset(imgMeta, '', 'StageCache', 'betl', 'StageCache.betl');
        findFieldOffset(imgMeta, 'TaskbarHero.Data', 'StageInfoData', 'StageKey', 'StageInfoData.StageKey');
        findFieldOffset(imgMeta, 'TaskbarHero.Data', 'StageInfoData', 'STAGEDIFFICULTY', 'StageInfoData.STAGEDIFFICULTY');
        findFieldOffset(imgMeta, 'TaskbarHero.Data', 'StageInfoData', 'Act', 'StageInfoData.Act');
        findFieldOffset(imgMeta, 'TaskbarHero.Data', 'StageInfoData', 'StageNo', 'StageInfoData.StageNo');
        findFieldOffset(imgMeta, 'TaskbarHero.Data', 'StageInfoData', 'StageLevel', 'StageInfoData.StageLevel');
        findFieldOffset(imgMeta, 'TaskbarHero.UI', 'UI_Portal', 'm_currentStageDifficulty', 'UI_Portal.m_currentStageDifficulty');
        findFieldOffset(imgMeta, 'TaskbarHero.UI', 'UI_Portal', 'bfzh', 'UI_Portal.bfzh');
        findFieldOffset(imgMeta, 'TaskbarHero.UI', 'UI_Portal', 'bfzi', 'UI_Portal.bfzi');
    }
    ui_buttonPressPtr = uiFindMethod('UnityEngine.UI', 'Button', 'Press', 0);
    ui_buttonPressInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Button', 'Press', 0);
    ui_buttonOnPointerClickPtr = uiFindMethod('UnityEngine.UI', 'Button', 'OnPointerClick', 1);
    ui_buttonOnPointerClickInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Button', 'OnPointerClick', 1);
    ui_dropdownOnPointerClickPtr = uiFindMethod('UnityEngine.UI', 'Dropdown', 'OnPointerClick', 1);
    ui_dropdownOnPointerClickInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Dropdown', 'OnPointerClick', 1);
    ui_dropdownShowPtr = uiFindMethod('UnityEngine.UI', 'Dropdown', 'Show', 0);
    ui_dropdownShowInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Dropdown', 'Show', 0);
    if (!ui_dropdownOnPointerClickPtr || ui_dropdownOnPointerClickPtr.isNull()) {
        ui_dropdownOnPointerClickPtr = uiFindMethod('TMPro', 'TMP_Dropdown', 'OnPointerClick', 1);
        ui_dropdownOnPointerClickInfoPtr = uiFindMethodInfo('TMPro', 'TMP_Dropdown', 'OnPointerClick', 1);
    }
    if (!ui_dropdownShowPtr || ui_dropdownShowPtr.isNull()) {
        ui_dropdownShowPtr = uiFindMethod('TMPro', 'TMP_Dropdown', 'Show', 0);
        ui_dropdownShowInfoPtr = uiFindMethodInfo('TMPro', 'TMP_Dropdown', 'Show', 0);
    }
    ui_toggleOnPointerClickPtr = uiFindMethod('UnityEngine.UI', 'Toggle', 'OnPointerClick', 1);
    ui_toggleOnPointerClickInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Toggle', 'OnPointerClick', 1);
    ui_toggleSetIsOnPtr = uiFindMethod('UnityEngine.UI', 'Toggle', 'set_isOn', 1);
    ui_toggleSetIsOnInfoPtr = uiFindMethodInfo('UnityEngine.UI', 'Toggle', 'set_isOn', 1);
    ui_eventSystemUpdatePtr = uiFindMethod('UnityEngine.EventSystems', 'EventSystem', 'Update', 0);
    ui_componentGetGameObjectPtr = uiFindMethod('UnityEngine', 'Component', 'get_gameObject', 0);
    ui_objectGetNamePtr = uiFindMethod('UnityEngine', 'Object', 'get_name', 0);
    ui_gameObjectGetActiveInHierarchyPtr = uiFindMethod('UnityEngine', 'GameObject', 'get_activeInHierarchy', 0);
    ui_selectableGetInteractablePtr = uiFindMethod('UnityEngine.UI', 'Selectable', 'get_interactable', 0);

    if (!ui_buttonPressPtr || ui_buttonPressPtr.isNull() || !ui_buttonOnPointerClickPtr || ui_buttonOnPointerClickPtr
        .isNull() || !ui_eventSystemUpdatePtr || ui_eventSystemUpdatePtr.isNull()) {
        log('[ui] replay unavailable: Button/EventSystem methods not found');
        return false;
    }

    uiHookUIPortalInstanceDiscovery();

    ui_buttonPress = new NativeFunction(ui_buttonPressPtr, 'void', ['pointer', 'pointer']);
    ui_buttonOnPointerClick = new NativeFunction(ui_buttonOnPointerClickPtr, 'void', ['pointer', 'pointer', 'pointer']);
    ui_dropdownOnPointerClick = ui_dropdownOnPointerClickPtr && !ui_dropdownOnPointerClickPtr.isNull() ? new NativeFunction(ui_dropdownOnPointerClickPtr, 'void', ['pointer', 'pointer', 'pointer']) : null;
    ui_dropdownShow = ui_dropdownShowPtr && !ui_dropdownShowPtr.isNull() ? new NativeFunction(ui_dropdownShowPtr, 'void', ['pointer', 'pointer']) : null;
    ui_toggleOnPointerClick = ui_toggleOnPointerClickPtr && !ui_toggleOnPointerClickPtr.isNull() ? new NativeFunction(ui_toggleOnPointerClickPtr, 'void', ['pointer', 'pointer', 'pointer']) : null;
    ui_toggleSetIsOn = ui_toggleSetIsOnPtr && !ui_toggleSetIsOnPtr.isNull() ? new NativeFunction(ui_toggleSetIsOnPtr, 'void', ['pointer', 'bool', 'pointer']) : null;
    ui_buttonPressMethodInfo = ui_buttonPressInfoPtr || ptr(0);
    ui_getGameObject = ui_componentGetGameObjectPtr && !ui_componentGetGameObjectPtr.isNull() ? new NativeFunction(
        ui_componentGetGameObjectPtr, 'pointer', ['pointer']) : null;
    ui_getObjectName = ui_objectGetNamePtr && !ui_objectGetNamePtr.isNull() ? new NativeFunction(ui_objectGetNamePtr,
        'pointer', ['pointer']) : null;
    ui_getActiveInHierarchy = ui_gameObjectGetActiveInHierarchyPtr && !ui_gameObjectGetActiveInHierarchyPtr.isNull() ?
        new NativeFunction(ui_gameObjectGetActiveInHierarchyPtr, 'bool', ['pointer']) : null;
    ui_getInteractable = ui_selectableGetInteractablePtr && !ui_selectableGetInteractablePtr.isNull() ?
        new NativeFunction(ui_selectableGetInteractablePtr, 'bool', ['pointer']) : null;

    Interceptor.attach(ui_buttonOnPointerClickPtr, {
        onEnter: function(args) {
            var n = uiObjectName(args[0]);
            if (n === 'StageNode(Clone)') uiCacheStageNodeInfo(args[0], 'Button.OnPointerClick');
            if (args[1] && !args[1].isNull()) ui_autoOpenLastPointerEvent = args[1];
            if (ui_autoOpenRecordKind) {
                var autoKind = ui_autoOpenRecordKind;
                ui_autoOpenRecordKind = '';
                var cursorPoint = uiCurrentCursorPoint();
                if (autoKind === 'boss') {
                    ui_autoOpenBossButton = args[0];
                    uiStatus('[自动开箱] 首领箱按钮已录制：' + args[0] + ' name=' + n);
                } else {
                    ui_autoOpenNormalButton = args[0];
                    uiStatus('[自动开箱] 普通箱按钮已录制：' + args[0] + ' name=' + n);
                }
                emitEvent('auto_open_recorded', {
                    kind: autoKind,
                    ptr: args[0].toString(),
                    name: n,
                    x: cursorPoint.x,
                    y: cursorPoint.y
                });
                return;
            }
            if (ui_recordTargetIndex >= 0) {
                var targetIndex = ui_recordTargetIndex;
                ui_recordTargetIndex = -1;
                uiRecordButtonAtIndex(args[0], targetIndex, ui_recordLabels[targetIndex] || ('录制UI #' + (targetIndex + 1)));
                if (uiAllRecorded()) {
                    uiStatus('[录制] 全部完成，可以开始循环');
                }
                return;
            }
            if (ui_flowState >= UI_FLOW_WAIT_FIRST && ui_flowState < UI_FLOW_RUNNING) {
                var recordIndex = ui_flowState - UI_FLOW_WAIT_FIRST;
                uiRecordButtonAtIndex(args[0], recordIndex, ui_recordLabels[recordIndex] || ('录制UI #' + (recordIndex + 1)));
                if (recordIndex + 1 < uiRecordCount()) {
                    ui_flowState++;
                    uiPromptRecordIndex(recordIndex + 1);
                } else {
                    ui_flowState = UI_FLOW_RUNNING;
                    ui_recordTargetIndex = -1;
                    uiStatus('[录制] 全部完成，可以开始循环');
                }
                return;
            }
            if (n !== 'StageNode(Clone)') return;
            log('[ui] StageNode clicked button=' + args[0]);
            var clickedStageLabel = uiFindRecordedStageByButton(args[0]);
            if (clickedStageLabel) {
                uiSyncNextIndexAfterManualClick(args[0]);
                ui_lastClickedStageLabel = clickedStageLabel;
                ui_pendingStageLabel = clickedStageLabel;
                uiStatus('[关卡] 手动点击：' + clickedStageLabel + '，等待掉落列表刷新确认');
            }
        }
    });

    if (ui_dropdownOnPointerClickPtr && !ui_dropdownOnPointerClickPtr.isNull()) {
        Interceptor.attach(ui_dropdownOnPointerClickPtr, {
            onEnter: function(args) {
                var n = uiObjectName(args[0]);
                if (args[1] && !args[1].isNull()) ui_autoOpenLastPointerEvent = args[1];
                if (ui_recordTargetIndex >= 0) {
                    var targetIndex = ui_recordTargetIndex;
                    ui_recordTargetIndex = -1;
                    uiRecordObjectAtIndex(args[0], targetIndex, ui_recordLabels[targetIndex] || ('录制UI #' + (targetIndex + 1)), 'dropdown');
                    return;
                }
                log('[ui] Dropdown clicked dropdown=' + args[0] + ' name=' + n);
            }
        });
    }

    if (ui_toggleOnPointerClickPtr && !ui_toggleOnPointerClickPtr.isNull()) {
        Interceptor.attach(ui_toggleOnPointerClickPtr, {
            onEnter: function(args) {
                var n = uiObjectName(args[0]);
                if (args[1] && !args[1].isNull()) ui_autoOpenLastPointerEvent = args[1];
                if (ui_recordTargetIndex >= 0) {
                    var targetIndex = ui_recordTargetIndex;
                    ui_recordTargetIndex = -1;
                    var difficulty = uiParseDifficultyName(n);
                    if (difficulty !== null && targetIndex >= UI_CROSS_START && targetIndex < UI_CROSS_START + UI_CROSS_COUNT) {
                        uiRecordDifficultyAtIndex(args[0], targetIndex, ui_recordLabels[targetIndex] || ('录制UI #' + (targetIndex + 1)), difficulty);
                    } else {
                        uiRecordObjectAtIndex(args[0], targetIndex, ui_recordLabels[targetIndex] || ('录制UI #' + (targetIndex + 1)), 'toggle');
                    }
                    return;
                }
                log('[ui] Toggle clicked toggle=' + args[0] + ' name=' + n);
            }
        });
    }

    Interceptor.attach(ui_buttonPressPtr, {
        onEnter: function(args) {
            if (args[1] && !args[1].isNull()) ui_buttonPressMethodInfo = args[1];
        }
    });

    Interceptor.attach(ui_eventSystemUpdatePtr, {
        onEnter: function(args) {
            var nowMs = Date.now();
            var hasPressQueue = ui_pendingPresses.length > 0 || ui_autoDepositPendingPresses.length > 0;
            var hasAutoOpenWork = ui_autoOpenEnabled || (ui_autoOpenReadyButton && !ui_autoOpenReadyButton.isNull()) || ui_autoOpenClickInFlight;
            if (!hasPressQueue && !hasAutoOpenWork) return;
            if (hasPressQueue && nowMs - ui_lastFrameDrainTickMs >= UI_FRAME_DRAIN_INTERVAL_MS) {
                ui_lastFrameDrainTickMs = nowMs;
                uiDrainPressQueue();
            }
            if (hasAutoOpenWork && nowMs - ui_lastAutoOpenTickMs >= UI_FRAME_AUTO_OPEN_INTERVAL_MS) {
                ui_lastAutoOpenTickMs = nowMs;
                uiAutoOpenTick();
            }
        }
    });

    log('[ui] replay ready. Button.Press RVA=0x' + ui_buttonPressPtr.sub(B).toInt32().toString(16));
    uiPromptMapReady();
    return true;
}

initUiReplay();

// ==============================
// Initialize drop hooks (after all definitions)
// ==============================
try {
    runVyHooks();
} catch(e) {
    console.log('runVyHooks failed: ' + e);
}

function handleHostCommand(message) {
    try {
        var payload = (message && message.payload) || {};
        var cmd = payload.cmd || '';
        var args = payload.args || [];
        if (cmd === 'ready') uiReady();
        else if (cmd === 'start') uiStartLoop();
        else if (cmd === 'stop') uiStopLoop();
        else if (cmd === 'startcross') uiStartCrossLoop();
        else if (cmd === 'stopcross') uiStopCrossLoop();
        else if (cmd === 'clear') {
            uiStopLoop();
            uiClearRecordedOnly();
            ui_pendingPresses = [];
            ui_autoDepositPendingPresses = [];
            ui_autoDepositRunning = false;
            ui_flowState = UI_FLOW_WAIT_MAP;
            uiPromptMapReady();
        } else if (cmd === 'recordbutton') {
            uiSetRecordTarget(parseInt(args[0], 10));
        } else if (cmd === 'recordautoopen') {
            ui_autoOpenRecordKind = args[0] === 'boss' ? 'boss' : 'normal';
            uiStatus('[自动开箱] 请在游戏里点击：' + (ui_autoOpenRecordKind === 'boss' ? '首领箱按钮' : '普通箱按钮'));
        } else if (cmd === 'clearrecordbutton') {
            uiClearRecordButtonAtIndex(parseInt(args[0], 10));
        } else if (cmd === 'clearautoopen') {
            uiClearAutoOpenButton(args[0] === 'boss' ? 'boss' : 'normal');
        } else if (cmd === 'autoopenclickdone') {
            ui_autoOpenClickInFlight = false;
        } else if (cmd === 'recordconfig') {
            uiApplyRecordConfig(args[0] || '{}');
        } else if (cmd === 'restorerecorded') {
            uiRestoreRecordedButtons(args[0] || '{}');
        } else if (cmd === 'updateconfig') {
            rpc.exports.updateconfig(args[0] || '{}');
        } else if (cmd === 'networkdrop') {
            var networkPayload = JSON.parse(args[0] || '{}');
            uiOnNetworkDropQueues('网络响应', networkPayload, networkPayload.currentStage || '');
        } else if (cmd === 'itemdropped') {
            var parsed = parseInt(args[0], 10);
            if (!isNaN(parsed)) uiOnItemDropped(parsed, args[1] || '箱子掉落', false);
        } else if (cmd === 'continuetimeshift') {
            uiContinueAfterTimeShift();
        } else if (cmd === 'press') {
            uiQueuePressIndex(parseInt(args[0], 10));
        } else if (cmd === 'resettimewait') {
            uiResetTimeWaitState();
        } else if (cmd === 'preparedetach') {
            uiPrepareDetach(true);
        }
    } catch (e) {
        log('[host] command failed: ' + e);
    } finally {
        recv('host-command', handleHostCommand);
    }
}
recv('host-command', handleHostCommand);

rpc.exports = {
    ready: function() {
        return uiReady();
    },
    start: function() {
        return uiStartLoop();
    },
    stop: function() {
        return uiStopLoop();
    },
    startcross: function() {
        return uiStartCrossLoop();
    },
    stopcross: function() {
        return uiStopCrossLoop();
    },
    status: function() {
        uiSaveCurrentRecordSet();
        return JSON.stringify({
            recorded: ui_recorded.map(function(p, i) {
                return p ? {
                    ptr: p.toString(),
                    label: ui_recordedLabels[i] || '',
                    kind: ui_recordedKinds[i] || 'button',
                    stageInfo: uiSerializeStageInfo(ui_recordedStageInfos[i]),
                    difficulty: ui_recordedDifficulties[i] == null ? null : ui_recordedDifficulties[i]
                } : null;
            }),
            recordSets: {
                time: ui_recordSets.time.recorded.map(function(p, i) {
                    return p ? { ptr: p.toString(), label: ui_recordSets.time.labels[i] || '', kind: (ui_recordSets.time.kinds || [])[i] || 'button', stageInfo: (ui_recordSets.time.stageInfos || [])[i] || null, difficulty: (ui_recordSets.time.difficulties || [])[i] == null ? null : (ui_recordSets.time.difficulties || [])[i] } : null;
                })
            },
            currentStage: uiStageDisplayName(ui_currentStageLabel),
            currentStageRaw: ui_currentStageLabel,
            pendingStage: uiStageDisplayName(ui_pendingStageLabel),
            pendingStageRaw: ui_pendingStageLabel,
            lastClickedStage: uiStageDisplayName(ui_lastClickedStageLabel),
            lastClickedStageRaw: ui_lastClickedStageLabel,
            running: ui_loopRunning,
            waitingForDrop: ui_waitingForDrop,
            waitingIndex: ui_waitingPressIndex,
            acceptNextListAsRefresh: ui_acceptNextListAsRefresh,
            monitorHold: ui_monitorHold,
            monitorHoldItems: ui_monitorHoldItems,
            monitorHoldExpectedCount: ui_monitorHoldExpectedCount,
            monitorHoldDeletedCount: ui_monitorHoldDeletedCount,
            flowState: ui_flowState,
            recordingIndex: ui_recordTargetIndex,
            pending: ui_pendingPresses.length + ui_autoDepositPendingPresses.length,
            crossLoop: {
                running: ui_crossLoopRunning,
                nextSide: ui_crossLoopNextSide,
                waitingSide: ui_crossLoopWaitingSide,
                lastClickedSide: ui_crossLoopLastClickedSide,
                lastCompletedSide: ui_crossLoopLastCompletedSide,
                resumeSide: ui_crossLoopResumeSide,
                ready: uiCrossReady()
            },
            nextAfterDropDelayMs: uiNextAfterDropDelayMs(),
            dropConfig: g_config
            ,
            autoDeposit: {
                enabled: uiAutoDepositEnabled(),
                minutes: Math.round(uiAutoDepositIntervalMs() / 60000),
                running: ui_autoDepositRunning,
                ready: uiAutoDepositReady(),
                lastRunMs: ui_autoDepositLastRunMs
            },
            autoOpen: {
                enabled: ui_autoOpenEnabled,
                normalPtr: ui_autoOpenNormalButton && !ui_autoOpenNormalButton.isNull() ? ui_autoOpenNormalButton.toString() : '',
                bossPtr: ui_autoOpenBossButton && !ui_autoOpenBossButton.isNull() ? ui_autoOpenBossButton.toString() : '',
                recordingKind: ui_autoOpenRecordKind
            }
        });
    },
    updateconfig: function(configJson) {
        var cfg = JSON.parse(configJson);
        var nextNormalCount = parseInt(cfg.normalCount, 10);
        var nextBossCount = parseInt(cfg.bossCount, 10);
        if (!isNaN(nextNormalCount)) g_config.display.normalCount = Math.max(0, nextNormalCount);
        if (!isNaN(nextBossCount)) g_config.display.bossCount = Math.max(0, nextBossCount);
        g_config.display.clickDelayMs = Math.max(0, parseInt(cfg.clickDelayMs, 10) || 0);
        g_config.display.pressIntervalMs = Math.max(0, parseInt(cfg.pressIntervalMs, 10) || 450);
        g_config.display.roleDeployDelayMs = Math.max(0, parseInt(cfg.roleDeployDelayMs, 10) || 800);
        uiSaveCurrentRecordSet('time');
        g_config.display.switchMode = 'time';
        uiUseRecordSet('time');
        g_config.display.loopPauseEvery = Math.max(0, parseInt(cfg.loopPauseEvery, 10) || 0);
        g_config.display.loopPauseMs = Math.max(0, parseInt(cfg.loopPauseMs, 10) || 0);
        g_config.display.timeShiftEvery = Math.max(1, parseInt(cfg.timeShiftEvery, 10) || 16);
        g_config.display.timeShiftRestoreMs = Math.max(0, parseInt(cfg.timeShiftRestoreMs, 10) || 0);
        g_config.display.timeShiftContinueMs = Math.max(0, parseInt(cfg.timeShiftContinueMs, 10) || 0);
        g_config.display.autoTimeShiftOnLimit = cfg.autoTimeShiftOnLimit === true;
        g_config.display.stageWaveCount = Math.max(0, parseInt(cfg.stageWaveCount, 10) || 0);
        if (g_config.display.stageWaveCount > 0) {
            installStageDataWaveHook();
            applyStageWaveCountNow();
        }
        var wasAutoDepositEnabled = g_config.display.autoDepositEnabled === true;
        g_config.display.autoDepositEnabled = cfg.autoDepositEnabled === true;
        g_config.display.autoDepositMinutes = Math.max(1, parseInt(cfg.autoDepositMinutes, 10) || 30);
        if (!wasAutoDepositEnabled && g_config.display.autoDepositEnabled === true) {
            ui_autoDepositLastRunMs = 0;
            if (!uiStartAutoDeposit('已开启')) uiScheduleAutoDepositTimer(5000);
        } else if (wasAutoDepositEnabled && g_config.display.autoDepositEnabled !== true) {
            uiClearAutoDepositTimer();
            ui_autoDepositRunning = false;
            ui_autoDepositPendingPresses = [];
        } else if (g_config.display.autoDepositEnabled === true && !ui_autoDepositRunning && ui_autoDepositPendingPresses.length === 0) {
            uiScheduleAutoDepositTimer(uiAutoDepositIntervalMs());
        }
        ui_autoOpenEnabled = cfg.autoOpenEnabled === true;
        ui_autoOpenNormalButton = uiPtrFromString(cfg.autoOpenNormalPtr || (ui_autoOpenNormalButton && !ui_autoOpenNormalButton.isNull() ? ui_autoOpenNormalButton.toString() : ''));
        ui_autoOpenBossButton = uiPtrFromString(cfg.autoOpenBossPtr || (ui_autoOpenBossButton && !ui_autoOpenBossButton.isNull() ? ui_autoOpenBossButton.toString() : ''));
        ui_autoOpenAppearDelayMs = Math.max(0, parseInt(cfg.autoOpenAppearDelayMs, 10) || 0);
        ui_autoOpenIntervalMs = Math.max(100, parseInt(cfg.autoOpenIntervalMs, 10) || 500);
        g_config.watch.enabled = cfg.watchEnabled !== false;
        g_config.watch.names = cfg.watchNames || [];
        g_config.watch.ids = cfg.watchIds || [];
        g_config.watch.matchMode = cfg.matchMode || g_config.watch.matchMode || 'exact';
        UI_CAPTURE_MODE = 'frida';
        g_config.watch.highlightBackgroundAnsi = cfg.highlightBackgroundAnsi || g_config.watch
            .highlightBackgroundAnsi || '\x1b[30;48;5;226m';
        log('[config] updated from UI: normal=' + g_config.display.normalCount + ', boss=' + g_config.display
            .bossCount + ', stageWaveCount=' + g_config.display.stageWaveCount + ', autoTimeShiftOnLimit=' + (g_config.display.autoTimeShiftOnLimit ? 'true' : 'false') + ', watch=' + g_config.watch.names.join('|'));
        return JSON.stringify(g_config);
    },
    press: function(index) {
        return uiPressIndexNow(parseInt(index, 10)) ? 'queued' : 'failed';
    },
    recordbutton: function(index) {
        return uiSetRecordTarget(index);
    },
    recordautoopen: function(kind) {
        ui_autoOpenRecordKind = kind === 'boss' ? 'boss' : 'normal';
        uiStatus('[自动开箱] 请在游戏里点击：' + (ui_autoOpenRecordKind === 'boss' ? '首领箱按钮' : '普通箱按钮'));
        return ui_autoOpenRecordKind;
    },
    clearrecordbutton: function(index) {
        return uiClearRecordButtonAtIndex(index);
    },
    clearautoopen: function(kind) {
        return uiClearAutoOpenButton(kind);
    },
    autoopenclickdone: function(kind, ok) {
        ui_autoOpenClickInFlight = false;
        return ok === '1' ? 'ok' : 'failed';
    },
    recordconfig: function(configJson) {
        return uiApplyRecordConfig(configJson || '{}');
    },
    restorerecorded: function(recordedJson) {
        return uiRestoreRecordedButtons(recordedJson);
    },
    networkdrop: function(payloadJson) {
        var payload = JSON.parse(payloadJson || '{}');
        return uiOnNetworkDropQueues('网络响应', payload, payload.currentStage || '') ? 'accepted' : 'ignored';
    },
    itemdropped: function(itemId, source) {
        var parsed = parseInt(itemId, 10);
        if (isNaN(parsed)) return 'ignored';
        uiOnItemDropped(parsed, source || '箱子掉落', false);
        return 'accepted';
    },
    continuetimeshift: function() {
        return uiContinueAfterTimeShift();
    },
    resettimewait: function() {
        uiResetTimeWaitState();
        return 'reset';
    },
    preparedetach: function() {
        return uiPrepareDetach(true);
    },
    clear: function() {
        uiStopLoop();
        uiClearRecordedOnly();
        ui_pendingPresses = [];
        ui_autoDepositPendingPresses = [];
        ui_autoDepositRunning = false;
        ui_flowState = UI_FLOW_WAIT_MAP;
        uiPromptMapReady();
        return 'cleared';
    }
};
