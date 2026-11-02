#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dlfcn.h>
#import <objc/message.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <libproc.h>
#import "darwin-recording.h"
#import "darwin-ocr.h"

static volatile sig_atomic_t cuCancelled = 0;
static BOOL cuOwnerPipe = NO;
static int cuInputLockFd = -1;
static _Thread_local NSProgress *__unsafe_unretained cuCommandProgress = nil;
static NSDictionary *cuLeaseKey = nil;
static pid_t cuLeasePid = 0;
static NSRunningApplication *cuLeaseApp = nil;
static NSDictionary *cuPointerLeaseContext = nil;
static NSDictionary *cuPointerLeaseElements = nil;
static NSRunningApplication *cuPointerLeaseApp = nil;
static NSMutableDictionary *cuElementSnapshots = nil;
static NSMutableArray *cuElementSnapshotOrder = nil;
static NSDictionary *cuValidatePointerLease(void);
#ifdef CU_TEST
static NSString *cuTestLockDir = nil;
static NSString *cuTestReleaseFile = nil;
static CGEventFlags cuTestInheritedTextFlags = 0;
static NSNumber *cuTestIdleSeconds = nil;
#endif
static void cuCancel(int signum) { cuCancelled = 1; }
static void cuCheckCancelled(void) {
  if(cuOwnerPipe) { struct pollfd fd={STDIN_FILENO,POLLHUP,0}; if(poll(&fd,1,0)>0 && (fd.revents&POLLHUP)) cuCancelled=1; }
  if(cuCancelled || cuCommandProgress.cancelled) @throw [NSException exceptionWithName:@"cancelled" reason:@"computer request cancelled" userInfo:nil];
}
static void cuLockInput(void) {
  // One physical desktop, including separately launched direct MCP hosts.
  // The kernel releases this lock if the native owner itself crashes.
  NSString *dir=[NSHomeDirectory() stringByAppendingPathComponent:@".codewhale-cu"];
#ifdef CU_TEST
  if(cuTestLockDir) dir=cuTestLockDir;
#endif
  [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:nil];
  int fd=open([[dir stringByAppendingPathComponent:@"input.lock"] fileSystemRepresentation],O_CREAT|O_RDWR|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0) @throw [NSException exceptionWithName:@"input_lock" reason:[NSString stringWithFormat:@"cannot open Computer Use input ownership lock: %s",strerror(errno)] userInfo:nil];
  struct stat st;
  if(fd<0 || fstat(fd,&st)!=0 || !S_ISREG(st.st_mode) || st.st_uid!=getuid() || flock(fd,LOCK_EX|LOCK_NB)!=0) {
    if(fd>=0) close(fd);
    @throw [NSException exceptionWithName:@"input_busy" reason:@"another Computer Use session owns held input; release its key or pointer before sending input" userInfo:nil];
  }
  cuInputLockFd=fd;
}
static BOOL cuFrontmostIsPid(pid_t pid);
static BOOL cuScreenLocked(void);
static NSNumber *cuWindowOnCurrentSpace(uint32_t wid);
static BOOL cuIsOwnHelper(NSRunningApplication *a) {
  return a.processIdentifier == getpid() || ([a.bundleIdentifier isEqual:@"net.codewhale.computer-use"] && [a.executableURL.lastPathComponent isEqual:@"accessibility"]);
}
static void cuRequireForeground(NSRunningApplication *expected) {
  NSRunningApplication *actual=NSWorkspace.sharedWorkspace.frontmostApplication;
  if(!cuFrontmostIsPid(expected.processIdentifier))
    @throw [NSException exceptionWithName:@"focus" reason:[NSString stringWithFormat:@"foreground changed to %@ (pid %d); expected %@ (pid %d). No key-down or text was sent to the new foreground application.",actual.localizedName?:@"unknown application",actual.processIdentifier,expected.localizedName?:@"bound application",expected.processIdentifier] userInfo:nil];
}
static id cuPostKey(NSDictionary *args, pid_t destination) {
  CGEventRef event=CGEventCreateKeyboardEvent(NULL,[args[@"code"] unsignedShortValue],[args[@"down"] boolValue]);
  CGEventSetFlags(event,[args[@"flags"] unsignedLongLongValue]);
  if([args[@"foreground_input"] boolValue]) CGEventPost(kCGHIDEventTap,event);
  else CGEventPostToPid(destination,event);
  CFRelease(event);
  return @{@"action_sent":@YES};
}
static void cuPrint(id result) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:nil];
  puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
}
static void cuReleaseLease(void) {
#ifdef CU_TEST
  if(cuTestReleaseFile) { [@"released" writeToFile:cuTestReleaseFile atomically:YES encoding:NSUTF8StringEncoding error:nil]; cuTestReleaseFile=nil; }
#endif
  if(cuLeaseKey) {
    NSMutableDictionary *up=[cuLeaseKey mutableCopy]; up[@"down"]=@NO;
    if([up[@"foreground_input"] boolValue] || !cuLeaseApp.terminated) cuPostKey(up,cuLeasePid);
    cuLeaseKey=nil; cuLeaseApp=nil;
  }
  cuPointerLeaseContext=nil; cuPointerLeaseElements=nil; cuPointerLeaseApp=nil;
  if(cuInputLockFd>=0) { close(cuInputLockFd); cuInputLockFd=-1; }
}
static void cuWaitForLease(void) {
  NSMutableData *buffer=[NSMutableData data];
  @try {
    while(!cuCancelled) {
      struct pollfd fd={STDIN_FILENO,POLLIN|POLLHUP,0};
      int ready=poll(&fd,1,100);
      if(ready<=0) continue;
      uint8_t bytes[4096]; ssize_t n=read(STDIN_FILENO,bytes,sizeof(bytes));
      if(n<=0) break;
      [buffer appendBytes:bytes length:(NSUInteger)n];
      if(buffer.length>65536) break;
      while(YES) {
        NSRange newline=[buffer rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0,buffer.length)];
        if(newline.location==NSNotFound) break;
        NSData *line=[buffer subdataWithRange:NSMakeRange(0,newline.location)];
        [buffer replaceBytesInRange:NSMakeRange(0,newline.location+1) withBytes:NULL length:0];
        id request=[NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if(![request isKindOfClass:NSDictionary.class] || [request[@"release"] boolValue] || ![request[@"validate"] boolValue] || !cuPointerLeaseContext) return;
        @try { cuPrint(cuValidatePointerLease()); }
        @catch(NSException *error) { cuPrint(@{@"validated":@NO,@"error":error.reason?:error.name}); return; }
      }
    }
  } @finally { cuReleaseLease(); }
}

/**
 * Window-routed events go to the target's process and never borrow the
 * front process. The host sends foreground_input or, in standard approval
 * mode, focus_lease; strict mode sends neither and keeps refusing them.
 */
static void cuRequireLease(NSDictionary *args) {
  if(![args[@"foreground_input"] boolValue] && ![args[@"focus_lease"] boolValue])
    @throw [NSException exceptionWithName:@"background_focus_required" reason:@"background_focus_required: this action needs a brief focus lease, which strict approval mode does not allow; no input was sent. Use accessibility, browser control, or a separate computer." userInfo:nil];
}
static void cuRequireFocusControl(NSDictionary *args) {
  if(![args[@"foreground_input"] boolValue])
    @throw [NSException exceptionWithName:@"background_focus_required" reason:@"background_focus_required: this action requires keyboard focus; no input was sent. Use accessibility, browser control, or a separate computer." userInfo:nil];
}
typedef OSStatus (*cuGetFrontFn)(ProcessSerialNumber *);
typedef OSStatus (*cuGetPSNFn)(pid_t, ProcessSerialNumber *);
typedef OSStatus (*cuSetFrontFn)(ProcessSerialNumber *, uint32_t, uint32_t);
typedef OSStatus (*cuPostRecordFn)(ProcessSerialNumber *, const void *);
typedef void (*cuSetWinLocFn)(CGEventRef, CGPoint);
typedef void (*cuSlPostFn)(pid_t, CGEventRef);
typedef void (*cuSlSetAuthFn)(CGEventRef, id);
static BOOL axActivate(pid_t pid);
static BOOL cuBgResolved = NO;
static cuGetFrontFn cuGetFront;
static cuGetPSNFn cuGetPSN;
static cuSetFrontFn cuSetFront;
static cuPostRecordFn cuPostRecord;
static cuSetWinLocFn cuSetWinLoc;
static cuSlPostFn cuSlPost;
static cuSlSetAuthFn cuSlSetAuth;
static BOOL cuResolveBgPointer(void) {
  if(cuBgResolved) return cuGetFront && cuGetPSN && cuSetFront && cuPostRecord && cuSetWinLoc && cuSlPost;
  cuBgResolved = YES;
  void *sl = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
  void *hs = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_LAZY);
  if(sl) {
    cuGetFront = (cuGetFrontFn)dlsym(sl, "_SLPSGetFrontProcess");
    cuSetFront = (cuSetFrontFn)dlsym(sl, "SLPSSetFrontProcessWithOptions");
    cuPostRecord = (cuPostRecordFn)dlsym(sl, "SLPSPostEventRecordTo");
    cuSetWinLoc = (cuSetWinLocFn)dlsym(sl, "CGEventSetWindowLocation");
    cuSlPost = (cuSlPostFn)dlsym(sl, "SLEventPostToPid");
    cuSlSetAuth = (cuSlSetAuthFn)dlsym(sl, "SLEventSetAuthenticationMessage");
  }
  if(hs) cuGetPSN = (cuGetPSNFn)dlsym(hs, "GetProcessForPID");
  return cuGetFront && cuGetPSN && cuSetFront && cuPostRecord && cuSetWinLoc && cuSlPost;
}
/**
 * Background input goes to the target process and never through the front
 * process, so the person's keyboard keeps going to their own app (pattern from
 * trycua/cua, MIT). SLEventPostToPid ticks the activity monitor, which
 * Chromium requires; keyboard events also carry an authentication message
 * (macOS 15+) for the same reason, except command chords: NSMenu key
 * equivalents fire only without it.
 */
static void cuPidPost(pid_t pid, CGEventRef e, BOOL authenticate) {
  if(authenticate && cuSlSetAuth) {
    Class cls = NSClassFromString(@"SLSEventAuthenticationMessage");
    SEL sel = NSSelectorFromString(@"messageWithEventRecord:pid:version:");
    void *record = *(void **)((char *)e + 0x18);
    if(cls && record && [cls respondsToSelector:sel]) {
      id message = ((id (*)(Class, SEL, void *, int, uint32_t))objc_msgSend)(cls, sel, record, pid, 0);
      if(message) cuSlSetAuth(e, message);
    }
  }
  cuSlPost(pid, e);
}
/**
 * A 248-byte window record to a process. Kind 0x0d with direction 1 makes the
 * window the app's focused window without activating or raising the app
 * (focus-without-raise, from yabai via trycua/cua, both MIT); kinds 0x01 and
 * 0x02 are the make-key pair. The person's app is never sent a defocus record:
 * that left its key window deaf to typing until it was clicked again.
 */
static void cuPostWindowRecord(ProcessSerialNumber *psn, uint32_t wid, uint8_t kind) {
  uint8_t rec[0xf8] = {0};
  rec[0x04] = 0xf8; rec[0x08] = kind;
  memcpy(rec + 0x3c, &wid, sizeof wid);
  if(kind == 0x0d) rec[0x8a] = 0x01;
  else { rec[0x3a] = 0x10; memset(rec + 0x20, 0xff, 0x10); }
  cuPostRecord(psn, rec);
}
/** Frontmost visible layer-0 window of pid containing p. */
static BOOL cuWindowAtPointForPid(pid_t pid, CGPoint p, uint32_t *outWin, CGRect *outFrame) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
  for(NSDictionary *w in windows) {
    if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid || [w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    NSNumber *alpha = w[(__bridge NSString *)kCGWindowAlpha];
    if(alpha && alpha.doubleValue <= 0) continue;
    CGRect frame;
    if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &frame) || !CGRectContainsPoint(frame,p)) continue;
    *outWin = [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    *outFrame = frame;
    return YES;
  }
  return NO;
}
/**
 * State for a window-routed background action. Measured on macOS 26.1 with an
 * AppKit fixture: keys, chords, typing, pixel clicks, drags and scroll reach a
 * background app posted to its process after a focus record to its window
 * alone, and the person's app keeps both front and key focus throughout. The
 * front process is never borrowed. A pointer gesture leads with an off-screen
 * primer press so first-mouse handling consumes it instead of the real press.
 * A menu opened in a background app does take key focus, so it is held across
 * calls only briefly (watchdog-capped) and closed with Escape. Chromium
 * rebuilds its AX tree lazily, so observes poll through the rebuild.
 */
typedef struct { ProcessSerialNumber targetPSN, postPSN; pid_t targetPid; pid_t postPid; uint32_t postWin; int64_t gesture; } cuBgLease;
static BOOL axActivate(pid_t pid);
static BOOL cuFrontmostIsPid(pid_t pid);
static id attr(AXUIElementRef el, NSString *name);
static void axPrepare(AXUIElementRef app);
/**
 * The frame and owner pid of a CGWindow by number — no pid filter, because
 * the window an action is routed to may belong to a hosting service.
 */
static BOOL cuWindowInfoForNumber(uint32_t winNum, CGRect *outFrame, pid_t *outPid) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
  for(NSDictionary *w in windows) {
    if([w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != winNum) continue;
    if(outPid) *outPid = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    if(outFrame) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], outFrame);
    return YES;
  }
  return NO;
}
/**
 * Service-hosted UI (openAndSavePanelService panels and similar XPC surfaces)
 * presents as TWO co-located windows at the same frame: a proxy owned by the
 * client app and the real window owned by the service. Records addressed to
 * the client die in its event queue — the key-equivalent and text handlers
 * run in the service's AppKit. A foreign window only takes over routing when
 * its owner is an XPC service: two ordinary apps can share a frame (two
 * maximized windows), and that must never redirect the user's input.
 */
static BOOL cuHostedWindowAtSameFrame(pid_t excludePid, CGRect f, uint32_t *outWin, pid_t *outPid) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
  for(NSDictionary *w in windows) {
    pid_t owner = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    if(owner == excludePid || [w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    CGRect b;
    if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &b)) continue;
    if(fabs(b.origin.x - f.origin.x) > 2 || fabs(b.origin.y - f.origin.y) > 2) continue;
    if(fabs(b.size.width - f.size.width) > 2 || fabs(b.size.height - f.size.height) > 2) continue;
    NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:owner];
    if(![ra.bundleIdentifier containsString:@".xpc."]) continue;
    *outWin = [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    if(outPid) *outPid = owner;
    return YES;
  }
  return NO;
}
// User-activity yield: before a moment that touches shared input — a front
// lease, a real-pointer gesture, foreground keys — wait for a gap in the
// person's hardware input rather than cutting between their keystrokes.
// kCGAnyInputEventType only counts hardware events (verified 2026-09-17:
// our posted events never tick it), so it is exactly "is the human using
// the machine right now". yield_gap_ms is the quiet window we wait for (0
// disables); yield_wait_ms bounds the wait. A busy desktop refuses before
// input is sent; a deadline is not permission to interrupt the person.
// Returns milliseconds yielded, 0 when the surface was already free.
static double cuYieldToUser(NSDictionary *args) {
  double gap=[args[@"yield_gap_ms"] doubleValue], wait=[args[@"yield_wait_ms"] doubleValue];
  if(gap<=0 || wait<=0) return 0;
  NSTimeInterval start=NSProcessInfo.processInfo.systemUptime;
  while(YES) {
    cuCheckCancelled();
    double idle=CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState,kCGAnyInputEventType);
#ifdef CU_TEST
    if(cuTestIdleSeconds) idle=cuTestIdleSeconds.doubleValue;
#endif
    double elapsed=(NSProcessInfo.processInfo.systemUptime-start)*1000.0;
    if(isfinite(idle) && idle>=0 && idle*1000.0>=gap) return elapsed;
    if(elapsed>=wait)
      @throw [NSException exceptionWithName:@"user_busy" reason:@"user_busy: no quiet input window became available; no input was sent. Wait for the user to finish before trying again." userInfo:nil];
    usleep((useconds_t)(fmin(40.0,wait-elapsed)*1000.0));
  }
}
static BOOL cuBgLeaseBegin(NSRunningApplication *inputApp, uint32_t winNum, BOOL makeKey, NSDictionary *args, cuBgLease *lease, NSString **why) {
  cuRequireLease(args);
  lease->targetPid = inputApp.processIdentifier;
  lease->gesture = (int64_t)(CFAbsoluteTimeGetCurrent() * 1e6) & 0x7fffffff;
  if(cuGetPSN(lease->targetPid, &lease->targetPSN) != 0) {
    *why = @"could not resolve the process serial number for a window-routed action; no input was sent";
    return NO;
  }
  cuCheckCancelled();
  // Records are addressed to the window's real owner, which is not always
  // the bound app: a service-hosted panel (openAndSavePanelService) leaves
  // a same-frame proxy in the client while its handlers run in the service.
  // Events posted to the client die in its queue, so the focus record and
  // the events go to the owning process.
  lease->postPid = lease->targetPid;
  lease->postPSN = lease->targetPSN;
  lease->postWin = winNum;
  {
    CGRect wf = CGRectZero;
    pid_t owner = 0;
    if(cuWindowInfoForNumber(winNum, &wf, &owner)) {
      pid_t real = 0; uint32_t realWin = 0;
      if(owner != lease->targetPid) {
        NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:owner];
        if([ra.bundleIdentifier containsString:@".xpc."]) { real = owner; realWin = winNum; }
      } else cuHostedWindowAtSameFrame(lease->targetPid, wf, &realWin, &real);
      if(real && cuGetPSN(real, &lease->postPSN) == 0) { lease->postPid = real; lease->postWin = realWin; }
      else { lease->postPSN = lease->targetPSN; }
    }
  }
  cuPostWindowRecord(&lease->postPSN, lease->postWin, 0x0d);
  usleep(50000);
  if(makeKey) {
    cuPostWindowRecord(&lease->postPSN, lease->postWin, 0x01);
    cuPostWindowRecord(&lease->postPSN, lease->postWin, 0x02);
    usleep(120000);
  }
  return YES;
}
static BOOL cuFrontmostIsPid(pid_t pid) {
  ProcessSerialNumber front, want;
  if(cuResolveBgPointer() && cuGetFront(&front) == 0 && cuGetPSN(pid, &want) == 0)
    return front.highLongOfPSN == want.highLongOfPSN && front.lowLongOfPSN == want.lowLongOfPSN;
  [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid;
}
/**
 * A menu opened in a background app takes key focus from the person's app
 * (measured), so it is held across calls only so the next pick can reach it:
 * the state file names it, the next raw-input call or a 6 s watchdog closes
 * it with Escape posted to that process, and nothing is done if it already
 * closed.
 */
static NSString *cuFrontLeaseFile(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".codewhale-cu/front-lease.json"];
}
static BOOL cuMenuOpenForApp(pid_t pid);
static void cuFrontLeaseRestoreIfHeld(void) {
  NSString *file = cuFrontLeaseFile();
  NSData *data = [NSData dataWithContentsOfFile:file];
  if(!data) return;
  NSDictionary *held = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  [NSFileManager.defaultManager removeItemAtPath:file error:nil];
  if(![held isKindOfClass:NSDictionary.class] || !cuResolveBgPointer()) return;
  pid_t targetPid = [held[@"targetPid"] intValue];
  if(targetPid <= 0 || !cuMenuOpenForApp(targetPid)) return;
  for(int down = 1; down >= 0; down--) {
    CGEventRef escape = CGEventCreateKeyboardEvent(NULL, 53, down);
    CGEventSetFlags(escape, 0);
    cuPidPost(targetPid, escape, NO);
    CFRelease(escape);
    usleep(20000);
  }
}
static BOOL cuFrontLeaseHeldForPid(pid_t pid) {
  NSData *data = [NSData dataWithContentsOfFile:cuFrontLeaseFile()];
  if(!data) return NO;
  NSDictionary *held = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [held isKindOfClass:NSDictionary.class] && [held[@"targetPid"] intValue] == pid;
}
static BOOL cuMenuOpenForApp(pid_t pid) {
  // An AppKit menu is its own window at the pop-up menu level, and the app
  // may not answer accessibility while it tracks the menu, so the window list
  // is checked first.
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
  for(NSDictionary *w in windows)
    if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid && [w[(__bridge NSString *)kCGWindowLayer] intValue] == kCGPopUpMenuWindowLevel) return YES;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 1.0);
  axPrepare(app);
  // Chromium vends an open select popup inside the window's subtree rather
  // than as an app-level AXMenu, so both shapes are searched, bounded.
  int budget = 400;
  NSMutableArray *stack = [NSMutableArray array];
  [stack addObjectsFromArray:attr(app, @"AXChildren") ?: @[]];
  [stack addObjectsFromArray:attr(app, @"AXWindows") ?: @[]];
  BOOL open = NO;
  while(stack.count && budget-- > 0 && !open) {
    id node = stack.lastObject;
    [stack removeLastObject];
    NSString *role = attr((__bridge AXUIElementRef)node, @"AXRole");
    if([role isEqual:@"AXMenu"]) { open = YES; break; }
    if([role isEqual:@"AXMenuBar"] || [role isEqual:@"AXMenuBarItem"]) continue;
    [stack addObjectsFromArray:attr((__bridge AXUIElementRef)node, @"AXChildren") ?: @[]];
  }
  CFRelease(app);
  return open;
}
static void cuHoldMenuForPid(pid_t pid);
static void cuFrontLeaseHold(cuBgLease *lease) { cuHoldMenuForPid(lease->targetPid); }
static void cuHoldMenuForPid(pid_t pid) {
  NSString *token = NSUUID.UUID.UUIDString;
  // Menu items take seconds to reappear in Chromium's rebuilt tree; the
  // observe+pick must fit inside the hold.
  NSNumber *deadline = @((long long)([NSDate new].timeIntervalSince1970 * 1000) + 6000);
  NSDictionary *state = @{ @"token": token, @"targetPid": @(pid), @"deadline": deadline };
  NSString *file = cuFrontLeaseFile();
  [NSFileManager.defaultManager createDirectoryAtPath:file.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
  if(!data || ![data writeToFile:file atomically:YES]) { cuFrontLeaseRestoreIfHeld(); return; }
  NSDictionary *req = @{ @"tool": @"front_lease_watchdog", @"args": @{ @"token": token, @"deadline": deadline } };
  NSData *reqData = [NSJSONSerialization dataWithJSONObject:req options:0 error:nil];
  if(reqData) {
    NSTask *watch = [NSTask new];
    watch.executableURL = [NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments[0]];
    watch.arguments = @[ [[NSString alloc] initWithData:reqData encoding:NSUTF8StringEncoding] ];
    watch.standardInput = NSFileHandle.fileHandleWithNullDevice;
    watch.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    watch.standardError = NSFileHandle.fileHandleWithNullDevice;
    [watch launchAndReturnError:nil];
  }
}
/**
 * Window routing fields plus a process post, shared by mouse, wheel and
 * keyboard events: the target pid (field 40, Chromium's synthetic-event
 * filter), the window (51, 91, 92), one gesture id (58) and the phase (0:
 * move 2, primer press 1/2, gesture 3).
 */
static void cuPostEventRecord(cuBgLease *lease, CGEventRef e, int64_t phase) {
  CGEventType type = CGEventGetType(e);
  BOOL keyboard = type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged;
  if(!keyboard) {
    CGEventSetIntegerValueField(e, 0, phase);
    CGEventSetIntegerValueField(e, 7, 3);
    CGEventSetIntegerValueField(e, 0x3a, lease->gesture);
  }
  CGEventSetIntegerValueField(e, 0x28, lease->postPid);
  CGEventSetIntegerValueField(e, 0x33, lease->postWin);
  CGEventSetIntegerValueField(e, 0x5b, lease->postWin);
  CGEventSetIntegerValueField(e, 0x5c, lease->postWin);
  cuSetWinLoc(e, CGEventGetLocation(e));
  cuPidPost(lease->postPid, e, keyboard && !(CGEventGetFlags(e) & kCGEventFlagMaskCommand));
}
/** Move to the gesture's start, then press and release off-screen. */
static void cuPostPointerPrimer(cuBgLease *lease, CGPoint at) {
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, at, kCGMouseButtonLeft);
  cuPostEventRecord(lease, move, 2);
  CFRelease(move);
  usleep(12000);
  for(int down = 1; down >= 0; down--) {
    CGEventRef e = CGEventCreateMouseEvent(NULL, down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp, CGPointMake(-1, -1), kCGMouseButtonLeft);
    CGEventSetIntegerValueField(e, kCGMouseEventClickState, 1);
    cuPostEventRecord(lease, e, down ? 1 : 2);
    CFRelease(e);
    usleep(down ? 10000 : 30000);
  }
}
static id attr(AXUIElementRef el, NSString *name);
static void axPrepare(AXUIElementRef app);
/** The CGWindowNumber and frame of the layer-0 window of pid whose frame matches an AX window rect. */
static BOOL cuWindowNumberForFrame(pid_t pid, CGRect axFrame, uint32_t *outWin) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
  uint32_t matched = 0;
  for(NSDictionary *w in windows) {
    if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
    if([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    CGRect b;
    if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &b)) continue;
    if(fabs(b.origin.x - axFrame.origin.x) > 2 || fabs(b.origin.y - axFrame.origin.y) > 2) continue;
    if(fabs(b.size.width - axFrame.size.width) > 2 || fabs(b.size.height - axFrame.size.height) > 2) continue;
    if(matched) return NO;
    matched = [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
  }
  if(matched) *outWin = matched;
  return matched != 0;
}
static id cuResolvePathTarget(pid_t pid, NSDictionary *t);
static void cuValidateElementIdentity(AXUIElementRef el, NSDictionary *target);
static BOOL cuElementWindow(id element, pid_t preferPid, uint32_t *outWin, pid_t *outOwner, NSString **outRole);
static BOOL cuObservedWindow(NSDictionary *observed, pid_t pid, CGPoint point, uint32_t *outWin, CGRect *outFrame) {
  NSDictionary *f = observed[@"frame"];
  CGRect expected = CGRectMake([f[@"x"] doubleValue],[f[@"y"] doubleValue],[f[@"w"] doubleValue],[f[@"h"] doubleValue]);
  uint32_t number = [observed[@"id"] unsignedIntValue];
  pid_t owner = 0;
  CGRect actual = CGRectZero;
  if([observed[@"pid"] intValue] != pid || !number || !cuWindowInfoForNumber(number,&actual,&owner) || owner != pid
     || !CGRectEqualToRect(expected,actual) || !CGRectContainsPoint(actual,point))
    @throw [NSException exceptionWithName:@"stale" reason:@"captured window moved, closed or changed ownership; capture it again before input; no input was sent" userInfo:nil];
  *outWin = number;
  *outFrame = actual;
  return YES;
}
static void cuWindowChord(cuBgLease *lease, CGKeyCode code, CGEventFlags flags) {
  cuCheckCancelled();
  for(int down = 1; down >= 0; down--) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL,code,down);
    CGEventSetFlags(event,flags);
    cuPostEventRecord(lease,event,3);
    CFRelease(event);
    usleep(30000);
  }
}
/** Whether the app's AXFocusedWindow is the window numbered wid. */
static BOOL cuAppKeyWindowIs(pid_t pid, uint32_t wid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 1.0);
  id window = attr(app, @"AXFocusedWindow");
  CFRelease(app);
  uint32_t number = 0;
  return window && cuElementWindow(window, pid, &number, nil, nil) && number == wid;
}
static BOOL cuFrame(AXUIElementRef el, CGRect *out);
static NSDictionary *cuPointerToolkit(NSRunningApplication *app) {
  BOOL chromium=[app.bundleIdentifier.lowercaseString containsString:@"chrome"] || [app.bundleIdentifier.lowercaseString containsString:@"chromium"];
  for(int flavor=22;flavor>=8;flavor-=14) {
    uint64_t address=0;
    BOOL readAny=NO;
    for(int i=0;i<65536;i++) {
      struct proc_regionwithpathinfo region={0};
      int n=proc_pidinfo(app.processIdentifier,flavor,address,&region,sizeof(region));
      if(n!=(int)sizeof(region)) break;
      readAny=YES;
      NSString *image=[NSString stringWithUTF8String:region.prp_vip.vip_path]?:@"";
      NSString *file=image.lastPathComponent.lowercaseString;
      if([image containsString:@"/Tk.framework/"] || ([file hasPrefix:@"_tkinter"] && [file hasSuffix:@".so"]) ||
         (([file hasPrefix:@"libtk"] || [file hasPrefix:@"libtcl9tk"]) && [file hasSuffix:@".dylib"]))
        @throw [NSException exceptionWithName:@"pointer_reading_toolkit" reason:@"pointer_reading_toolkit: Tk derives input coordinates from the hardware cursor. Window-routed pointer input was refused before dispatch; use accessible controls or a separate computer." userInfo:nil];
      if([image containsString:@"/Electron Framework.framework/"] || [image containsString:@"/Chromium Framework.framework/"] || [image containsString:@"/Google Chrome Framework.framework/"]) chromium=YES;
      uint64_t next=region.prp_prinfo.pri_address+region.prp_prinfo.pri_size;
      if(next<=address) break;
      address=next;
    }
    if(readAny) break;
  }
  return @{@"chromium":@(chromium)};
}
static NSSet *cuDragWindows(pid_t pid);
static NSDictionary *cuPointerContext(NSRunningApplication *inputApp, NSDictionary *args, NSMutableDictionary *elements) {
  if(cuDragWindows(inputApp.processIdentifier).count)
    @throw [NSException exceptionWithName:@"drag_session_active" reason:@"drag_session_active: the target already has a native drag session; finish it before sending another pointer gesture" userInfo:nil];
  NSArray *steps=args[@"steps"];
  if(![steps isKindOfClass:NSArray.class] || !steps.count || steps.count>400)
    @throw [NSException exceptionWithName:@"args" reason:@"bg_pointer needs 1..400 steps" userInfo:nil];
  CGPoint anchor=CGPointMake([steps[0][@"x"] doubleValue],[steps[0][@"y"] doubleValue]);
  uint32_t winNum=0; CGRect frame=CGRectZero; BOOL found=NO;
  if(args[@"observed_window"]) found=cuObservedWindow(args[@"observed_window"],inputApp.processIdentifier,anchor,&winNum,&frame);
  else if([args[@"target"][@"type"] isEqual:@"element"]) {
    id el=cuResolvePathTarget(inputApp.processIdentifier,args[@"target"]);
    if(!el) @throw [NSException exceptionWithName:@"stale" reason:@"element is no longer available; observe again" userInfo:nil];
    cuValidateElementIdentity((__bridge AXUIElementRef)el,args[@"target"]);
    found=cuElementWindow(el,inputApp.processIdentifier,&winNum,nil,nil) && cuWindowInfoForNumber(winNum,&frame,nil) && CGRectContainsPoint(frame,anchor);
  } else found=cuWindowAtPointForPid(inputApp.processIdentifier,anchor,&winNum,&frame);
  if(!found) @throw [NSException exceptionWithName:@"window" reason:@"no window of the bound application covers the start point; no input was sent" userInfo:nil];
  for(NSDictionary *step in steps) {
    double x=[step[@"x"] doubleValue],y=[step[@"y"] doubleValue];
    if(![step[@"x"] isKindOfClass:NSNumber.class] || ![step[@"y"] isKindOfClass:NSNumber.class] || !isfinite(x) || !isfinite(y) || !CGRectContainsPoint(frame,CGPointMake(x,y)))
      @throw [NSException exceptionWithName:@"window" reason:@"every pointer step must remain inside the same bound window; no input was sent" userInfo:nil];
  }
  NSMutableDictionary *context=[cuPointerToolkit(inputApp) mutableCopy];
  context[@"pid"]=@(inputApp.processIdentifier);
  context[@"window"]=@{@"id":@(winNum),@"x":@(frame.origin.x),@"y":@(frame.origin.y),@"w":@(frame.size.width),@"h":@(frame.size.height)};
  AXUIElementRef ax=AXUIElementCreateApplication(inputApp.processIdentifier);
  axPrepare(ax);
  @try {
    for(id w in attr(ax,@"AXWindows")) {
      CGRect f; if(!cuFrame((__bridge AXUIElementRef)w,&f) || !CGRectEqualToRect(f,frame)) continue;
      if(elements) elements[@"window"]=w;
      context[@"title"]=attr((__bridge AXUIElementRef)w,@"AXTitle")?:@"";
      NSArray *sheets=attr((__bridge AXUIElementRef)w,@"AXSheets");
      if(sheets.count && [context[@"chromium"] boolValue])
        @throw [NSException exceptionWithName:@"modal" reason:@"window blocked by modal sheet; observe and handle the dialog first" userInfo:nil];
      NSMutableArray *queue=[NSMutableArray arrayWithObject:w];
      for(NSUInteger i=0;i<queue.count && i<1600;i++) {
        AXUIElementRef node=(__bridge AXUIElementRef)queue[i];
        CGRect b;
        if([attr(node,@"AXRole") isEqual:@"AXWebArea"] && cuFrame(node,&b) && CGRectContainsPoint(b,anchor)) {
          if(context[@"web"]) @throw [NSException exceptionWithName:@"window" reason:@"multiple web surfaces cover this point; the target is ambiguous" userInfo:nil];
          if(elements) elements[@"web"]=(__bridge id)node;
          id url=attr(node,@"AXURL");
          context[@"web"]=@{@"x":@(b.origin.x),@"y":@(b.origin.y),@"w":@(b.size.width),@"h":@(b.size.height),@"title":attr(node,@"AXTitle")?:@"",@"url":[url isKindOfClass:NSURL.class]?[url absoluteString]:([url isKindOfClass:NSString.class]?url:@"")};
        } else if(queue.count<1600) [queue addObjectsFromArray:attr(node,@"AXChildren")?:@[]];
      }
      break;
    }
  } @finally { CFRelease(ax); }
  return context;
}
static NSDictionary *cuValidatePointerLease(void) {
  cuCheckCancelled();
  if(!AXIsProcessTrusted()) @throw [NSException exceptionWithName:@"permission" reason:@"Accessibility permission was revoked; no further input is allowed" userInfo:nil];
  if(cuScreenLocked()) @throw [NSException exceptionWithName:@"screen_locked" reason:@"screen_locked: the Mac is locked; no further input is allowed" userInfo:nil];
  if(cuPointerLeaseApp.terminated) @throw [NSException exceptionWithName:@"stale" reason:@"the pointer application exited; observe before retrying" userInfo:nil];
  pid_t pid=[cuPointerLeaseContext[@"pid"] intValue];
  NSDictionary *w=cuPointerLeaseContext[@"window"],*web=cuPointerLeaseContext[@"web"];
  CGRect expected=CGRectMake([w[@"x"] doubleValue],[w[@"y"] doubleValue],[w[@"w"] doubleValue],[w[@"h"] doubleValue]),actual;
  pid_t owner=0;
  if(!cuWindowInfoForNumber([w[@"id"] unsignedIntValue],&actual,&owner) || owner!=pid || !CGRectEqualToRect(expected,actual))
    @throw [NSException exceptionWithName:@"stale" reason:@"the pointer window moved, closed or changed ownership; observe before retrying" userInfo:nil];
  if(cuDragWindows(pid).count) @throw [NSException exceptionWithName:@"drag_session_active" reason:@"drag_session_active: a native drag session started; no further pointer input is allowed" userInfo:nil];
  AXUIElementRef window=(__bridge AXUIElementRef)cuPointerLeaseElements[@"window"];
  AXUIElementRef surface=(__bridge AXUIElementRef)cuPointerLeaseElements[@"web"];
  if(!window || !surface || [attr(window,@"AXSheets") count] || ![attr(surface,@"AXRole") isEqual:@"AXWebArea"])
    @throw [NSException exceptionWithName:@"stale" reason:@"the pointer web surface changed or is blocked by a sheet; observe before retrying" userInfo:nil];
  CGRect b;
  id url=attr(surface,@"AXURL"),title=attr(surface,@"AXTitle")?:@"";
  NSString *text=[url isKindOfClass:NSURL.class]?[url absoluteString]:([url isKindOfClass:NSString.class]?url:@"");
  if(!web || !cuFrame(surface,&b) || !CGRectEqualToRect(b,CGRectMake([web[@"x"] doubleValue],[web[@"y"] doubleValue],[web[@"w"] doubleValue],[web[@"h"] doubleValue])) || ![title isEqual:web[@"title"]] || ![text isEqual:web[@"url"]])
    @throw [NSException exceptionWithName:@"stale" reason:@"the pointer web surface geometry, title or URL changed; observe before retrying" userInfo:nil];
  return @{@"validated":@YES};
}
static NSSet *cuDragWindows(pid_t pid) {
  NSMutableSet *ids=[NSMutableSet set];
  NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly,kCGNullWindowID));
  for(NSDictionary *w in windows) if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue]==pid && [w[(__bridge NSString *)kCGWindowLayer] intValue]==kCGDraggingWindowLevel)
    [ids addObject:w[(__bridge NSString *)kCGWindowNumber]];
  return ids;
}
static NSDictionary *cuBgPointer(NSRunningApplication *inputApp, NSDictionary *args) {
  if(!cuResolveBgPointer())
    @throw [NSException exceptionWithName:@"bg_dispatch_unavailable" reason:@"window-routed background pointer is unavailable: SLPSPostEventRecordTo/CGEventSetWindowLocation not resolvable via SkyLight; no input was sent" userInfo:nil];
  NSMutableDictionary *elements=[args[@"prepare_only"] boolValue]?[NSMutableDictionary dictionary]:nil;
  NSDictionary *context=cuPointerContext(inputApp,args,elements);
  NSArray *steps=args[@"steps"];
  CGPoint anchor=CGPointMake([steps[0][@"x"] doubleValue],[steps[0][@"y"] doubleValue]);
  uint32_t winNum=[context[@"window"][@"id"] unsignedIntValue];
  CGRect frame=CGRectMake([context[@"window"][@"x"] doubleValue],[context[@"window"][@"y"] doubleValue],[context[@"window"][@"w"] doubleValue],[context[@"window"][@"h"] doubleValue]);
  if([args[@"prepare_only"] boolValue]) {
    if(![args[@"input_lease"] boolValue] || ![args[@"owner_pipe"] boolValue]) @throw [NSException exceptionWithName:@"args" reason:@"a prepared pointer route needs a live input owner" userInfo:nil];
    cuPointerLeaseContext=context; cuPointerLeaseElements=elements; cuPointerLeaseApp=inputApp;
    NSMutableDictionary *ready=[context mutableCopy]; ready[@"action_sent"]=@NO; ready[@"input_prepared"]=@YES; return ready;
  }
  BOOL dragging=NO,hover=YES;
  for(NSDictionary *step in steps) {
    int type=[step[@"type"] intValue];
    if(type==kCGEventLeftMouseDragged || type==kCGEventRightMouseDragged || type==kCGEventOtherMouseDragged) dragging=YES;
    if(type!=kCGEventMouseMoved || step[@"scroll"]) hover=NO;
  }
  if([context[@"chromium"] boolValue] && (dragging || hover))
    @throw [NSException exceptionWithName:@"chromium_pointer_unavailable" reason:@"chromium_pointer_unavailable: this Chromium gesture needs the renderer input route; update the helper and plugin together. No routed mouse event was sent." userInfo:nil];
  NSSet *dragBefore=cuDragWindows(inputApp.processIdentifier);
  if(dragging && dragBefore.count) @throw [NSException exceptionWithName:@"drag_session_active" reason:@"drag_session_active: the target already has a native drag session; finish it before sending another gesture" userInfo:nil];
  int heldType=0,heldButton=0; CGPoint heldPoint=anchor;
  // A secondary or middle press usually opens a menu, and a menu takes the
  // person's key focus, so it waits for a gap in their typing first.
  double yieldMs = 0;
  for(NSDictionary *step in steps) {
    int type = [step[@"type"] intValue];
    if(type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown) { yieldMs = cuYieldToUser(args); break; }
  }
  cuBgLease lease;
  NSString *why = nil;
  if(!cuBgLeaseBegin(inputApp, winNum, NO, args, &lease, &why))
    @throw [NSException exceptionWithName:@"bg_dispatch_unavailable" reason:why userInfo:nil];
  BOOL menuLeaseHeld = NO;
  @try {
    if(args[@"observed_window"]) cuObservedWindow(args[@"observed_window"],inputApp.processIdentifier,anchor,&winNum,&frame);
    BOOL primed = NO;
    for(NSDictionary *step in steps) {
      cuCheckCancelled();
      CGRect current; pid_t owner=0;
      if(!cuWindowInfoForNumber(winNum,&current,&owner) || owner!=inputApp.processIdentifier || !CGRectEqualToRect(current,frame))
        @throw [NSException exceptionWithName:@"stale" reason:@"pointer window moved, closed or changed ownership during the gesture; observe before retrying" userInfo:nil];
      if([step[@"scroll"] isKindOfClass:NSArray.class]) {
        NSArray *d = step[@"scroll"];
        // Pixel units: Chromium ignores line-unit wheel events entirely
        // (measured). One notch ≈ one line ≈ 40 px.
        CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, [d[1] intValue] * 40, [d[0] intValue] * 40);
        CGEventSetLocation(wheel, anchor);
        cuPostEventRecord(&lease, wheel, 3);
        CFRelease(wheel);
      } else {
        CGPoint p = CGPointMake([step[@"x"] doubleValue], [step[@"y"] doubleValue]);
        int type = [step[@"type"] intValue], button = [step[@"button"] intValue];
        BOOL press = type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown;
        if(press && !primed) { cuPostPointerPrimer(&lease, p); primed = YES; }
        CGEventRef e = CGEventCreateMouseEvent(NULL, (CGEventType)type, p, (CGMouseButton)button);
        CGEventSetIntegerValueField(e, kCGMouseEventClickState, [step[@"clickState"] longLongValue]);
        BOOL pressed = type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown
                    || type == kCGEventLeftMouseDragged || type == kCGEventRightMouseDragged || type == kCGEventOtherMouseDragged;
        CGEventSetDoubleValueField(e, 2, pressed ? 1.0 : 0.0);
        CGEventSetIntegerValueField(e, kCGMouseEventButtonNumber, button);
        if(press) { heldType=type; heldButton=button; }
        heldPoint=p;
        cuPostEventRecord(&lease, e, type == kCGEventMouseMoved ? 2 : 3);
        if(type==kCGEventLeftMouseUp || type==kCGEventRightMouseUp || type==kCGEventOtherMouseUp) heldType=0;
        CFRelease(e);
      }
      usleep((useconds_t)MAX(1,MIN(250,[step[@"delayMs"] intValue] ?: 20)) * 1000);
      if(dragging && ![cuDragWindows(inputApp.processIdentifier) isSubsetOfSet:dragBefore]) {
        cuWindowChord(&lease,53,0);
        @throw [NSException exceptionWithName:@"drag_session_detected" reason:@"drag_session_detected: the gesture started a native drag session, which follows the hardware cursor. It was cancelled and released; the requested drop is not confirmed. Observe before using a menu or keyboard alternative; do not replay this drag." userInfo:nil];
      }
    }
    // Menus animate in after the mouse-up, so a click-ending gesture polls
    // briefly. A web popup needs the poll to ride out Chromium's AX rebuild
    // (seconds), which the caller asks for with menu_poll_ms.
    {
      int lastType = -1;
      for(NSDictionary *step in [steps reverseObjectEnumerator]) {
        if([step[@"type"] isKindOfClass:NSNumber.class]) { lastType = [step[@"type"] intValue]; break; }
      }
      BOOL clickEnded = lastType == kCGEventLeftMouseUp || lastType == kCGEventRightMouseUp || lastType == kCGEventOtherMouseUp;
      NSInteger pollMs = MAX(0, MIN(10000, [args[@"menu_poll_ms"] integerValue] ?: 720));
      menuLeaseHeld = cuMenuOpenForApp(inputApp.processIdentifier);
      if(!menuLeaseHeld && clickEnded) {
        for(NSInteger waited = 0; waited < pollMs && !menuLeaseHeld; waited += 60) {
          usleep(60000);
          menuLeaseHeld = cuMenuOpenForApp(inputApp.processIdentifier);
        }
      }
    }
  } @finally {
    if(dragging && ![cuDragWindows(inputApp.processIdentifier) isSubsetOfSet:dragBefore]) {
      for(int down=1;down>=0;down--) {
        CGEventRef escape=CGEventCreateKeyboardEvent(NULL,53,down); CGEventSetFlags(escape,0);
        cuPidPost(lease.postPid,escape,NO); CFRelease(escape);
      }
    }
    if(heldType) {
      CGEventType up=heldType==kCGEventLeftMouseDown?kCGEventLeftMouseUp:heldType==kCGEventRightMouseDown?kCGEventRightMouseUp:kCGEventOtherMouseUp;
      CGEventRef release=CGEventCreateMouseEvent(NULL,up,heldPoint,(CGMouseButton)heldButton);
      cuPostEventRecord(&lease,release,3); CFRelease(release);
    }
    if(menuLeaseHeld) cuFrontLeaseHold(&lease);
  }
  NSMutableDictionary *receipt = [@{@"action_sent":@YES, @"strategy":@"pid-routed", @"pointer_moved":@NO,
           @"front_lease":@NO, @"window":@{@"id":@(lease.postWin)}} mutableCopy];
  if(lease.postPid != lease.targetPid) receipt[@"window_owner_pid"] = @(lease.postPid);
  if(yieldMs > 0) receipt[@"yield_ms"] = @(round(yieldMs));
  if(menuLeaseHeld) { receipt[@"menu_lease_held"] = @YES; receipt[@"menu_holds_key_focus"] = @YES; }
  return receipt;
}
static id attr(AXUIElementRef el, NSString *name) {
#ifdef CU_TEST
  // The observation fixture exercises the real walker without reading a GUI.
  if([(__bridge id)el isKindOfClass:NSDictionary.class]) return ((__bridge NSDictionary *)el)[name];
#endif
  CFTypeRef out = NULL;
  AXError e = AXUIElementCopyAttributeValue(el, (__bridge CFStringRef)name, &out);
  return e == kAXErrorSuccess ? CFBridgingRelease(out) : nil;
}
/**
 * Opt the target into full accessibility. Chromium-family apps (Chrome,
 * Electron) and WebKit content do not vend AXWebArea descendants until an
 * assistive client sets AXEnhancedUserInterface; Firefox-style engines gate
 * behind AXManualAccessibility. Without this an observe returns the chrome
 * of the window — menu bar, toolbar, tab strip — and no page content at all.
 * Apps that do not know these attributes simply refuse the write.
 */
static void axPrepare(AXUIElementRef app) {
#ifdef CU_TEST
  if([(__bridge id)app isKindOfClass:NSDictionary.class]) return;
#endif
  AXUIElementSetAttributeValue(app,(__bridge CFStringRef)@"AXEnhancedUserInterface",kCFBooleanTrue);
  AXUIElementSetAttributeValue(app,(__bridge CFStringRef)@"AXManualAccessibility",kCFBooleanTrue);
}
static void axSetEnhancedUI(AXUIElementRef app, BOOL on) {
#ifdef CU_TEST
  if([(__bridge id)app isKindOfClass:NSMutableDictionary.class]) {
    NSMutableDictionary *fake=(__bridge NSMutableDictionary *)app;
    fake[@"AXEnhancedUserInterface"]=@(on);
    [fake[@"writes"] addObject:on?@"AXEnhancedUserInterface=1":@"AXEnhancedUserInterface=0"];
    return;
  }
#endif
  AXUIElementSetAttributeValue(app,(__bridge CFStringRef)@"AXEnhancedUserInterface",on?kCFBooleanTrue:kCFBooleanFalse);
}
/**
 * Run window geometry writes with AXEnhancedUserInterface off. While it is on
 * (axPrepare turns it on for every app we observe, and it stays on for the life
 * of that process) AppKit animates each AXPosition/AXSize write over ~200 ms,
 * and a later write cancels the running animation where it stands: a 50 ms
 * position re-assert froze a 1100x800 -> 1600x900 resize at 1232x827. Window
 * managers (Rectangle, yabai) clear the attribute around frame writes for the
 * same reason. It is restored afterwards, even if the writes throw, so content
 * observation of Chromium/WebKit apps keeps working.
 */
static void cuWithoutEnhancedUI(AXUIElementRef app, void (^work)(void)) {
  id eui=attr(app,@"AXEnhancedUserInterface");
  BOOL wasOn=[eui isKindOfClass:NSNumber.class] && [eui boolValue];
  if(wasOn) axSetEnhancedUI(app,NO);
  @try { work(); }
  @finally { if(wasOn) axSetEnhancedUI(app,YES); }
}
static NSDictionary *geometry(id v, BOOL size) {
  if (!v || CFGetTypeID((__bridge CFTypeRef)v) != AXValueGetTypeID()) return nil;
  if (size) { CGSize s; if (AXValueGetValue((__bridge AXValueRef)v,kAXValueCGSizeType,&s)) return @{ @"w":@(s.width), @"h":@(s.height) }; }
  else { CGPoint p; if (AXValueGetValue((__bridge AXValueRef)v,kAXValueCGPointType,&p)) return @{ @"x":@(p.x), @"y":@(p.y) }; }
  return nil;
}
static NSDictionary *info(AXUIElementRef el, NSInteger index, NSInteger win, NSArray *path) {
  NSMutableDictionary *d = [@{@"index":@(index), @"windowIndex":@(win), @"path":path} mutableCopy];
  for (NSString *key in @[@"role",@"subrole",@"value",@"enabled",@"focused"]) {
    NSDictionary *names = @{@"role":@"AXRole",@"subrole":@"AXSubrole",@"value":@"AXValue",@"enabled":@"AXEnabled",@"focused":@"AXFocused"};
    id v = attr(el,names[key]);
    if ([v isKindOfClass:NSString.class]) d[key] = [v length]>12000 ? [v substringToIndex:12000] : v;
    else if ([v isKindOfClass:NSNumber.class]) d[key] = v;
  }
  id label = attr(el,@"AXTitle");
  if (![label isKindOfClass:NSString.class] || ![label length]) label = attr(el,@"AXDescription");
  if ([label isKindOfClass:NSString.class]) d[@"label"] = label;
  id p=geometry(attr(el,@"AXPosition"),NO), s=geometry(attr(el,@"AXSize"),YES);
  if(p) d[@"position"]=p; if(s) d[@"size"]=s;
  CFArrayRef actions=NULL;
#ifdef CU_TEST
  if([(__bridge id)el isKindOfClass:NSDictionary.class]) d[@"actions"]=attr(el,@"actions")?:@[];
  else
#endif
  if(AXUIElementCopyActionNames(el,&actions)==kAXErrorSuccess) d[@"actions"]=CFBridgingRelease(actions);
  else d[@"actions"]=@[];
  return d;
}
static NSArray *cuProcessInstance(pid_t pid) {
  struct proc_bsdinfo info={0};
  if(pid<=0 || proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=(int)sizeof(info) || info.pbi_pid!=pid) return nil;
  return @[@(info.pbi_start_tvsec),@(info.pbi_start_tvusec)];
}
static void cuValidateElementIdentity(AXUIElementRef el, NSDictionary *target) {
  NSString *ref=target[@"native_ref"];
  if(ref) {
    NSArray *parts=[ref isKindOfClass:NSString.class]?[ref componentsSeparatedByString:@":"]:@[];
    NSDictionary *snapshot=parts.count==2?cuElementSnapshots[parts[0]]:nil;
    id retained=snapshot[@"elements"][ref];
    NSArray *live=cuProcessInstance([snapshot[@"pid"] intValue]);
    if(!retained || !live || ![live isEqual:snapshot[@"started"]] ||
       !CFEqual((__bridge CFTypeRef)retained,el))
      @throw [NSException exceptionWithName:@"stale" reason:@"element_stale: the observed native control or its owner changed or expired; observe again before acting" userInfo:nil];
  }
  NSDictionary *current=info(el,0,0,@[]);
  for(NSString *key in @[@"role",@"label"]) {
    id expected=target[key]?:NSNull.null, actual=current[key]?:NSNull.null;
    if(![expected isEqual:actual]) @throw [NSException exceptionWithName:@"stale" reason:[NSString stringWithFormat:@"element changed %@; observe again before acting",key] userInfo:nil];
  }
}
static void walk(AXUIElementRef el, NSInteger win, NSArray *path, NSInteger depth, NSInteger limit, NSInteger max, BOOL depthIsTruncation, NSMutableArray *out, BOOL *truncated, NSMutableDictionary *refs, NSString *snapshotId) {
  // Breadth first keeps a long file listing from hiding its dialog buttons.
  NSMutableArray *queue=[NSMutableArray arrayWithObject:@{@"el":(__bridge id)el,@"path":path,@"depth":@(depth)}];
  for(NSUInteger cursor=0;cursor<queue.count;cursor++) {
    if(out.count>=max){ *truncated=YES; break; }
    NSDictionary *item=queue[cursor];
    AXUIElementRef current=(__bridge AXUIElementRef)item[@"el"];
    NSArray *currentPath=item[@"path"];
    NSInteger currentDepth=[item[@"depth"] integerValue];
    NSMutableDictionary *row=[info(current,out.count,win,currentPath) mutableCopy];
    if(refs) {
      NSString *ref=[NSString stringWithFormat:@"%@:%lu",snapshotId,(unsigned long)out.count];
      refs[ref]=(__bridge id)current;
      row[@"native_ref"]=ref;
    }
    [out addObject:row];
    NSArray *kids=attr(current,@"AXChildren");
    if(currentDepth>=limit){ if(kids.count && depthIsTruncation) *truncated=YES; continue; }
    for(NSUInteger i=0;i<kids.count;i++) {
      if(queue.count-cursor>=(NSUInteger)max){ *truncated=YES; break; }
      [queue addObject:@{@"el":kids[i],@"path":[currentPath arrayByAddingObject:@(i)],@"depth":@(currentDepth+1)}];
    }
  }
}
static NSArray *observeElements(AXUIElementRef app, NSArray *ws, NSDictionary *args, BOOL listWindows, BOOL *truncated) {
  NSMutableArray *out=[NSMutableArray array];
  NSMutableDictionary *refs=listWindows?nil:[NSMutableDictionary dictionary];
#ifdef CU_TEST
  if([(__bridge id)app isKindOfClass:NSDictionary.class]) refs=nil;
#endif
  NSString *snapshotId=refs?NSUUID.UUID.UUIDString:nil;
  BOOL full=[args[@"detail"] isEqual:@"full"];
  // Web content nests deep: a browser form's controls commonly sit 12+ levels
  // under the window, and a real page holds hundreds of controls. Depth and
  // budget must cover that or every browser observe is silently headless.
  // A filtered observe (query/role) is a targeted search, not a page dump, so
  // it earns the deep budget — a control past the summary depth must still be
  // findable.
  BOOL deep=full||args[@"query"]||args[@"role"];
  NSInteger limit=deep?24:16, max=deep?1600:900;
  if(!listWindows && !args[@"window_id"]) {
    // Open popup menus remain useful. Hidden menu-bar descendants belong in
    // the full view; summary reserves their budget for the app's actual UI.
    NSInteger menuMax=max/4;
    NSArray *children=attr(app,@"AXChildren");
    for(NSUInteger i=0;i<children.count;i++) {
      NSString *role=attr((__bridge AXUIElementRef)children[i],@"AXRole");
      if([role isEqual:@"AXMenu"]) walk((__bridge AXUIElementRef)children[i],-2,@[@(i)],0,limit,menuMax/2,YES,out,truncated,refs,snapshotId);
    }
    id menu=attr(app,@"AXMenuBar");
    if(menu) walk((__bridge AXUIElementRef)menu,-1,@[],0,full?limit:1,menuMax,full,out,truncated,refs,snapshotId);
  }
  for(NSUInteger i=0;i<ws.count;i++) {
    if(args[@"window_id"] && i!=[args[@"window_id"] unsignedIntegerValue]) continue;
    if(listWindows){ NSMutableDictionary *d=[info((__bridge AXUIElementRef)ws[i],i,i,@[]) mutableCopy]; d[@"title"]=d[@"label"]?:@""; [out addObject:d]; }
    else walk((__bridge AXUIElementRef)ws[i],i,@[],0,limit,max,YES,out,truncated,refs,snapshotId);
  }
  if(refs) {
    pid_t pid=0;
    AXUIElementGetPid(app,&pid);
    NSArray *started=cuProcessInstance(pid);
    if(!started)
      @throw [NSException exceptionWithName:@"stale" reason:@"element_stale: the observed application's process identity is unavailable; observe again" userInfo:nil];
    if(!cuElementSnapshots) { cuElementSnapshots=[NSMutableDictionary dictionary]; cuElementSnapshotOrder=[NSMutableArray array]; }
    cuElementSnapshots[snapshotId]=@{@"elements":refs,@"pid":@(pid),@"started":started};
    [cuElementSnapshotOrder addObject:snapshotId];
    while(cuElementSnapshotOrder.count>24) { [cuElementSnapshots removeObjectForKey:cuElementSnapshotOrder[0]]; [cuElementSnapshotOrder removeObjectAtIndex:0]; }
  }
  return out;
}
/**
 * An AXWebArea whose recorded path produced no descendants is a page the walk
 * could not see into — typically Chromium still assembling its accessibility
 * subtree right after AXEnhancedUserInterface was set. Worth one re-observe
 * after a short settle rather than reporting an empty page.
 */
static BOOL hasOrphanWebArea(NSArray *out) {
  for(NSDictionary *d in out) {
    if(![d[@"role"] isEqual:@"AXWebArea"]) continue;
    NSArray *p=d[@"path"]; NSInteger w=[d[@"windowIndex"] integerValue];
    BOOL kids=NO;
    for(NSDictionary *e in out) {
      if(e==d || [e[@"windowIndex"] integerValue]!=w) continue;
      NSArray *q=e[@"path"];
      if(q.count<=p.count) continue;
      BOOL prefix=YES;
      for(NSUInteger i=0;i<p.count;i++) if(![q[i] isEqual:p[i]]) { prefix=NO; break; }
      if(prefix) { kids=YES; break; }
    }
    if(!kids) return YES;
  }
  return NO;
}
static BOOL cuFrame(AXUIElementRef el, CGRect *out) {
  NSDictionary *p=geometry(attr(el,@"AXPosition"),NO), *z=geometry(attr(el,@"AXSize"),YES);
  if(!p || !z) return NO;
  *out=CGRectMake([p[@"x"] doubleValue],[p[@"y"] doubleValue],[z[@"w"] doubleValue],[z[@"h"] doubleValue]);
  return YES;
}
static AXError cuSetWindowGeometry(AXUIElementRef win, NSString *name, AXValueRef value) {
#ifdef CU_TEST
  // A fake window records each write with the app's enhanced-UI state at that
  // moment, then stores the value so cuFrame reads it back.
  if([(__bridge id)win isKindOfClass:NSMutableDictionary.class]) {
    NSMutableDictionary *fake=(__bridge NSMutableDictionary *)win, *app=fake[@"app"];
    [app[@"writes"] addObject:[NSString stringWithFormat:@"%@(AXEnhancedUserInterface=%d)",name,[app[@"AXEnhancedUserInterface"] boolValue]]];
    if([fake[@"refuse"] boolValue]) return kAXErrorCannotComplete;
    fake[name]=(__bridge id)value;
    return kAXErrorSuccess;
  }
#endif
  return AXUIElementSetAttributeValue(win,(__bridge CFStringRef)name,value);
}
/**
 * Write a window's frame and read back what the app actually applied. The
 * writes and the readback run with AXEnhancedUserInterface off (see
 * cuWithoutEnhancedUI); pe/se report the position and size write errors.
 * Throws when the app refuses both.
 */
static CGRect cuWriteWindowFrame(AXUIElementRef app, AXUIElementRef win, CGRect target, CGRect before, AXError *outPe, AXError *outSe) {
  double fx=target.origin.x, fy=target.origin.y, fw=target.size.width, fh=target.size.height;
  CGPoint p=target.origin; CGSize z=target.size;
  __block AXError pe=kAXErrorFailure, se=kAXErrorFailure;
  __block CGRect after=before;
  @try {
    cuWithoutEnhancedUI(app,^{
      AXValueRef pos=AXValueCreate(kAXValueCGPointType,&p), size=AXValueCreate(kAXValueCGSizeType,&z);
      @try {
        pe=cuSetWindowGeometry(win,@"AXPosition",pos);
        se=cuSetWindowGeometry(win,@"AXSize",size);
        // Some apps re-anchor a window's origin when its size changes; re-assert
        // the position once after the size has had a run-loop turn to settle.
        if(pe==kAXErrorSuccess) {
          [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
          AXError pe2=cuSetWindowGeometry(win,@"AXPosition",pos);
          if(pe2!=kAXErrorSuccess) pe=pe2;
        }
      } @finally { if(pos) CFRelease(pos); if(size) CFRelease(size); }
      if(pe!=kAXErrorSuccess && se!=kAXErrorSuccess)
        @throw [NSException exceptionWithName:@"window" reason:@"the app refused the window frame change (it may be fullscreen, tiled or non-resizable)" userInfo:nil];
      // Apps apply frame changes over a few run-loop turns; verify by reading the
      // window's own geometry back, not by trusting the set call. The readback
      // stays inside the enhanced-UI-off window so no animation is in flight
      // when the attribute is restored.
      for(int i=0;i<40;i++) {
        cuCheckCancelled();
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        cuFrame(win,&after);
        if(fabs(after.origin.x-fx)<1 && fabs(after.origin.y-fy)<1 && fabs(after.size.width-fw)<1 && fabs(after.size.height-fh)<1) break;
      }
    });
  } @finally {
    if(outPe) *outPe=pe;
    if(outSe) *outSe=se;
  }
  return after;
}
/**
 * The CGWindow that should receive input for an element. An AXSheet ancestor
 * is preferred over the app AXWindow: a hosted panel (openAndSavePanelService)
 * is bridged into the client's tree as a sheet but is its own real window,
 * owned by the service. The window lookup prefers the client pid, then a
 * co-located XPC-service window — the service's window is the one whose
 * handlers actually consume events. outRole names the resolved ancestor.
 */
static BOOL cuElementWindow(id element, pid_t preferPid, uint32_t *outWin, pid_t *outOwner, NSString **outRole) {
  id sheet = nil, win = nil;
  id node = element;
  for(int depth = 0; node && depth < 64; depth++) {
    NSString *r = attr((__bridge AXUIElementRef)node, @"AXRole");
    if([r isEqual:@"AXSheet"] && !sheet) sheet = node;
    else if([r isEqual:@"AXWindow"]) { win = node; break; }
    else if([r isEqual:@"AXApplication"]) break;
    id parent = attr((__bridge AXUIElementRef)node, @"AXParent");
    if(!parent || CFEqual((__bridge CFTypeRef)parent, (__bridge CFTypeRef)node)) break;
    node = parent;
  }
  for(id cand in @[sheet ?: [NSNull null], win ?: [NSNull null]]) {
    if(cand == [NSNull null]) continue;
    CGRect f;
    if(!cuFrame((__bridge AXUIElementRef)cand, &f)) continue;
    uint32_t w = 0; pid_t o = 0;
    BOOL nativeWindow=cand==win && !sheet;
#ifdef CU_TEST
    if([cand isKindOfClass:NSDictionary.class]) nativeWindow=NO;
#endif
    if(nativeWindow) {
      static AXError (*bridge)(AXUIElementRef,uint32_t *)=NULL;
      static dispatch_once_t once;
      dispatch_once(&once,^{ bridge=dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow"); });
      AXError status=bridge?bridge((__bridge AXUIElementRef)cand,&w):kAXErrorAttributeUnsupported;
      if(status==kAXErrorSuccess) {
        CGRect actual;
        if(!w || !cuWindowInfoForNumber(w,&actual,&o) || o!=preferPid || fabs(actual.origin.x-f.origin.x)>2 || fabs(actual.origin.y-f.origin.y)>2 || fabs(actual.size.width-f.size.width)>2 || fabs(actual.size.height-f.size.height)>2) continue;
        *outWin=w;
        if(outOwner) *outOwner=o;
        if(outRole) *outRole=@"AXWindow";
        return YES;
      }
      if(status!=kAXErrorAttributeUnsupported && status!=kAXErrorNoValue && status!=kAXErrorIllegalArgument) continue;
    }
    if(cuWindowNumberForFrame(preferPid, f, &w)) {
      o = preferPid;
      uint32_t fw = 0; pid_t fo = 0;
      if(cuHostedWindowAtSameFrame(preferPid, f, &fw, &fo)) { w = fw; o = fo; }
    } else if(!cuHostedWindowAtSameFrame(preferPid, f, &w, &o)) continue;
    *outWin = w;
    if(outOwner) *outOwner = o;
    if(outRole) *outRole = attr((__bridge AXUIElementRef)cand, @"AXRole");
    return YES;
  }
  return NO;
}
static NSDictionary *capturableWindow(NSArray *windows, pid_t pid, NSString *name, CGRect preferred) {
  NSDictionary *matched=nil;
  for(NSDictionary *w in windows) {
    if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue]!=pid || [w[(__bridge NSString *)kCGWindowLayer] intValue]!=0) continue;
    CGRect b; if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds],&b) || b.size.width<1 || b.size.height<1) continue;
    if(fabs(b.origin.x-preferred.origin.x)>1 || fabs(b.origin.y-preferred.origin.y)>1 || fabs(b.size.width-preferred.size.width)>1 || fabs(b.size.height-preferred.size.height)>1) continue;
    if(matched) @throw [NSException exceptionWithName:@"window" reason:@"the selected window is ambiguous; observe the app windows again" userInfo:nil];
    matched=@{@"window_id":w[(__bridge NSString *)kCGWindowNumber],@"name":name?:@"App",@"points":@{@"x":@(b.origin.x),@"y":@(b.origin.y),@"w":@(b.size.width),@"h":@(b.size.height)}};
  }
  if(!matched) @throw [NSException exceptionWithName:@"window" reason:@"the selected app window is not capturable; observe the app windows again" userInfo:nil];
  return matched;
}
static NSArray *cuActions(AXUIElementRef el) {
  CFArrayRef names=NULL;
#ifdef CU_TEST
  if([(__bridge id)el isKindOfClass:NSDictionary.class]) return attr(el,@"actions")?:@[];
#endif
  return AXUIElementCopyActionNames(el,&names)==kAXErrorSuccess?CFBridgingRelease(names):@[];
}
static BOOL cuSettable(AXUIElementRef el, NSString *name) {
#ifdef CU_TEST
  if([(__bridge id)el isKindOfClass:NSDictionary.class]) return [attr(el,@"settable") containsObject:name];
#endif
  Boolean settable=false;
  return AXUIElementIsAttributeSettable(el,(__bridge CFStringRef)name,&settable)==kAXErrorSuccess && settable;
}
static BOOL axHasWebAncestor(AXUIElementRef el);
static NSString *cuClickAction(AXUIElementRef el, BOOL context) {
  id enabled=attr(el,@"AXEnabled");
  if([enabled isKindOfClass:NSNumber.class] && ![enabled boolValue]) return nil;
  NSArray *actions=cuActions(el);
  if(context) return [actions containsObject:@"AXShowMenu"]?@"AXShowMenu":nil;
  NSString *role=attr(el,@"AXRole");
  // A web popup button's AXPress does not open the native menu — only a real
  // mouse event does. Reporting it unpressable routes the click through the
  // window-record path, which opens the menu the page actually shows.
  if([@[@"AXMenuButton",@"AXPopUpButton"] containsObject:role] && axHasWebAncestor(el)) return nil;
  // Pressing a text field is toolkit-dependent; focus its insertion point directly.
  if([@[@"AXTextField",@"AXTextArea",@"AXComboBox"] containsObject:role] && cuSettable(el,@"AXFocused")) return @"AXFocused";
  if([actions containsObject:@"AXPress"]) return @"AXPress";
  if([role isEqual:@"AXMenuItem"] && [actions containsObject:@"AXPick"]) return @"AXPick";
  if([@[@"AXRow",@"AXCell"] containsObject:role] && cuSettable(el,@"AXSelected")) return @"AXSelected";
  // Focusing is the missing middle between "not pressable" and a real click,
  // but only for explicit text-entry roles. Anything else — a span, a group,
  // Chromium's page-content container, Qt composers — is better served by the
  // window-record click the caller falls back to: focusing a container is not
  // a click, and reporting one would swallow the press.
  if(cuSettable(el,@"AXFocused") && [@[@"AXTextField",@"AXTextArea",@"AXComboBox",@"AXSearchField",@"AXSecureTextField"] containsObject:role]) return @"AXFocused";
  return nil;
}
static BOOL cuMenuOpenForApp(pid_t pid);
static void cuHoldMenuForPid(pid_t pid);
static NSDictionary *cuClick(AXUIElementRef el, BOOL context, NSDictionary *args) {
  // A control whose rendered frame is empty is one a user could not click:
  // virtualized lists and collapsed regions vend elements that do not exist on
  // screen. Pressing one either does nothing or toggles a row the caller
  // cannot see. Refuse with the recovery spelled out.
  NSDictionary *sz=geometry(attr(el,@"AXSize"),YES);
  if(sz && ([sz[@"w"] doubleValue]<=0 || [sz[@"h"] doubleValue]<=0))
    @throw [NSException exceptionWithName:@"degenerate_frame" reason:@"target element has a degenerate frame (zero size); it is hidden or collapsed in a virtualized container — scroll it into view and observe again before clicking" userInfo:nil];
  NSString *action=cuClickAction(el,context);
  if(!action) @throw [NSException exceptionWithName:@"background_action_unavailable" reason:@"this control has no supported accessibility click; observe its advertised actions or use a separate computer" userInfo:nil];
  // A menu opened in a background app takes the person's key focus, so a
  // press that opens one waits for a gap in their typing first.
  NSString *role=attr(el,@"AXRole");
  BOOL opensMenu=[action isEqual:@"AXShowMenu"] || [@[@"AXPopUpButton",@"AXMenuButton"] containsObject:role];
  double yieldMs=opensMenu && args ? cuYieldToUser(args) : 0;
  cuCheckCancelled();
  BOOL attribute=[action isEqual:@"AXFocused"] || [action isEqual:@"AXSelected"];
  AXError error=attribute?AXUIElementSetAttributeValue(el,(__bridge CFStringRef)action,kCFBooleanTrue):AXUIElementPerformAction(el,(__bridge CFStringRef)action);
  if(error!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"action" reason:[NSString stringWithFormat:@"accessibility %@ failed: %d; no pointer fallback was sent",action,error] userInfo:nil];
  NSMutableDictionary *receipt=[@{@"action_sent":@YES,@"strategy":@"a11y",@"action":action,@"pointer_moved":@NO,
           @"verified":@(attribute && [attr(el,action) boolValue])} mutableCopy];
  if(yieldMs>0) receipt[@"yield_ms"]=@(round(yieldMs));
  pid_t pid=0;
  if(opensMenu && AXUIElementGetPid(el,&pid)==kAXErrorSuccess && pid>0) {
    BOOL open=NO;
    for(int waited=0; waited<720 && !(open=cuMenuOpenForApp(pid)); waited+=60) usleep(60000);
    if(open) { cuHoldMenuForPid(pid); receipt[@"menu_lease_held"]=@YES; receipt[@"menu_holds_key_focus"]=@YES; }
  }
  return receipt;
}
static id cuScrollBar(AXUIElementRef el, BOOL horizontal) {
  id enabled=attr(el,@"AXEnabled");
  if([enabled isKindOfClass:NSNumber.class] && ![enabled boolValue]) return nil;
  return attr(el,horizontal?@"AXHorizontalScrollBar":@"AXVerticalScrollBar");
}
static NSDictionary *cuKeyboardScroll(AXUIElementRef el, NSDictionary *args) {
  id web=(__bridge id)el,focusTarget=nil;
  BOOL editable=NO;
  for(int i=0;web && i<64;i++) {
    NSString *role=attr((__bridge AXUIElementRef)web,@"AXRole");
    if([role isEqual:@"AXWebArea"]) break;
    if([role isEqual:@"AXScrollArea"] && !focusTarget) focusTarget=web;
    if([@[@"AXTextField",@"AXTextArea",@"AXComboBox",@"AXSearchField",@"AXSecureTextField"] containsObject:role]) editable=YES;
    if([role isEqual:@"AXWindow"] || [role isEqual:@"AXApplication"]) { web=nil; break; }
    web=attr((__bridge AXUIElementRef)web,@"AXParent");
  }
  if(!web || ![attr((__bridge AXUIElementRef)web,@"AXRole") isEqual:@"AXWebArea"])
    @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:@"no accessibility scrollbar or focusable web page at this target" userInfo:nil];
  if(editable) @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:@"keyboard scroll fallback refuses text controls; it could move a caret instead of scrolling" userInfo:nil];
  focusTarget=focusTarget?:web;
  cuRequireLease(args);
  uint32_t wid=0; pid_t pid=0;
  AXUIElementGetPid(el,&pid);
  if(!cuResolveBgPointer() || !cuElementWindow(web,pid,&wid,nil,nil))
    @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:@"the web page's key window could not be resolved; no scroll key was sent" userInfo:nil];
  cuBgLease lease; NSString *why=nil;
  if(!cuBgLeaseBegin([NSRunningApplication runningApplicationWithProcessIdentifier:pid],wid,YES,args,&lease,&why))
    @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:why userInfo:nil];
  if(!cuAppKeyWindowIs(pid,wid)) @throw [NSException exceptionWithName:@"key_window_unconfirmed" reason:@"key_window_unconfirmed: no scroll key was sent" userInfo:nil];
  AXUIElementRef page=(__bridge AXUIElementRef)focusTarget;
  if(!cuSettable(page,@"AXFocused") || AXUIElementSetAttributeValue(page,kAXFocusedAttribute,kCFBooleanTrue)!=kAXErrorSuccess)
    @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:@"the web page cannot take accessibility focus; no scroll key was sent" userInfo:nil];
  usleep(40000);
  AXUIElementRef app=AXUIElementCreateApplication(pid);
  id focused=attr(app,@"AXFocusedUIElement"); CFRelease(app);
  if(!focused || !CFEqual((__bridge CFTypeRef)focused,(__bridge CFTypeRef)focusTarget))
    @throw [NSException exceptionWithName:@"background_scroll_unavailable" reason:@"the web page's focus could not be confirmed; no scroll key was sent (it might edit or select text)" userInfo:nil];
  NSString *direction=args[@"direction"];
  CGKeyCode key=[direction isEqual:@"left"]?123:[direction isEqual:@"right"]?124:[direction isEqual:@"up"]?126:125;
  NSInteger count=MAX(1,MIN(100,[args[@"amount"] integerValue]));
  for(NSInteger i=0;i<count;i++) {
    cuCheckCancelled();
    app=AXUIElementCreateApplication(pid); focused=attr(app,@"AXFocusedUIElement"); CFRelease(app);
    if(!cuAppKeyWindowIs(pid,wid) || !focused || !CFEqual((__bridge CFTypeRef)focused,(__bridge CFTypeRef)focusTarget))
      @throw [NSException exceptionWithName:@"focus" reason:@"web scroll focus changed; no further key was sent; observe before retrying" userInfo:nil];
    cuWindowChord(&lease,key,0);
  }
  return @{@"action_sent":@YES,@"strategy":@"keyboard-scroll",@"keyboard_delivery":@"process",@"pointer_moved":@NO,@"front_lease":@NO,@"verified":@NO,@"verification_required":@"observation",@"unit":@"line",@"amount":@(count),@"window":@{@"id":@(wid)}};
}
static NSDictionary *cuScroll(AXUIElementRef el, NSDictionary *args) {
  BOOL horizontal=[@[@"left",@"right"] containsObject:args[@"direction"]];
  id bar=nil;
  for(id cur=(__bridge id)el;cur && !bar;) {
    AXUIElementRef node=(__bridge AXUIElementRef)cur;
    bar=cuScrollBar(node,horizontal);
    if([attr(node,@"AXRole") isEqual:@"AXWindow"]) break;
    cur=attr(node,@"AXParent");
  }
  if(!bar) return cuKeyboardScroll(el,args);
  AXUIElementRef control=(__bridge AXUIElementRef)bar;
  BOOL forward=[@[@"down",@"right"] containsObject:args[@"direction"]];
  NSString *action=forward?@"AXIncrement":@"AXDecrement";
  NSInteger count=MAX(1,MIN(100,[args[@"amount"] integerValue]));
  id before=attr(control,@"AXValue");
  BOOL advertised=[cuActions(control) containsObject:action];
  // Native scrollbars commonly expose a normalized value instead of actions.
  // Report that unit explicitly: it is not a claim about a toolkit's line size.
  BOOL normalized=!advertised && [before isKindOfClass:NSNumber.class] && [before doubleValue]>=0 && [before doubleValue]<=1 && cuSettable(control,@"AXValue");
  if(!advertised && !normalized) return cuKeyboardScroll(el,args);
  for(NSInteger i=0;i<(advertised?count:1);i++) {
    cuCheckCancelled();
    NSNumber *value=@(MAX(0,MIN(1,[before doubleValue]+(forward?1:-1)*0.05*count)));
    AXError error=advertised?AXUIElementPerformAction(control,(__bridge CFStringRef)action):AXUIElementSetAttributeValue(control,kAXValueAttribute,(__bridge CFTypeRef)value);
    if(error!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"action" reason:[NSString stringWithFormat:@"accessibility scroll failed: %d; no pointer fallback was sent",error] userInfo:nil];
  }
  id after=attr(control,@"AXValue");
  return @{@"action_sent":@YES,@"strategy":@"a11y",@"pointer_moved":@NO,@"action":advertised?action:@"AXValue",
           @"unit":advertised?@"accessibility_increment":@"normalized_scrollbar",@"before":before?:NSNull.null,@"after":after?:NSNull.null,
           @"verified":@(before && after && ![before isEqual:after])};
}
/**
 * Smallest pressable element whose frame contains p.
 *
 * AXUIElementCopyElementAtPosition is the first resolver, but several toolkits
 * (Chromium's browser process among them) answer it with the window rather
 * than the control the user sees, so a coordinate would silently degrade to a
 * raw event. Searching the subtree geometrically recovers the real target;
 * "smallest containing" is what picks the button instead of its group. Bounded
 * so a huge tree cannot stall an action.
 */
static void cuSearch(AXUIElementRef el, CGPoint p, int depth, int *budget, id *best, double *bestArea, NSString *operation) {
  if(depth>24 || (*budget)--<=0) return;
  CGRect frame;
  if(cuFrame(el,&frame)) {
    // Children are laid out inside their parent (and clipped when they are
    // not), so a frame that misses the point prunes the whole subtree.
    if(!CGRectContainsPoint(frame,p)) return;
    double area=frame.size.width*frame.size.height;
    BOOL suitable=[operation hasPrefix:@"scroll"]?(cuScrollBar(el,[operation isEqual:@"scroll-horizontal"])!=nil || [attr(el,@"AXRole") isEqual:@"AXWebArea"]):cuClickAction(el,[operation isEqual:@"context"])!=nil;
    if(suitable && (!*best || area<=*bestArea)) { *best=(__bridge id)el; *bestArea=area; }
  }
  for(id kid in attr(el,@"AXChildren")) cuSearch((__bridge AXUIElementRef)kid,p,depth+1,budget,best,bestArea,operation);
}
/**
 * Every key an app_ref supplies must match. Matching any one of them would let
 * {pid, bundle_id} land on a *different* process of the same bundle — the
 * user's own browser instead of the one the agent opened — and then type into
 * their window. Identity here is a conjunction, deliberately.
 */
static BOOL matchesName(NSString *have, NSString *want) {
  return have && [have caseInsensitiveCompare:want]==NSOrderedSame;
}
/**
 * Bring an application forward. -[NSRunningApplication activateWithOptions:]
 * is ignored on macOS 14+ when the caller is not itself frontmost, which a
 * background helper never is. The WindowServer's own front-process channel
 * (0x200 = raising) works from any TCC-trusted process; setting AXFrontmost
 * through the Accessibility grant is the fallback.
 */
static BOOL axActivate(pid_t pid) {
  if(cuResolveBgPointer()) {
    ProcessSerialNumber psn;
    if(cuGetPSN(pid,&psn)==0 && cuSetFront(&psn,0,0x200)==0) return YES;
  }
  AXUIElementRef app=AXUIElementCreateApplication(pid);
  AXError e=AXUIElementSetAttributeValue(app,kAXFrontmostAttribute,kCFBooleanTrue);
  CFRelease(app);
  return e==kAXErrorSuccess;
}
static NSRunningApplication *resolve(NSDictionary *ref) {
  // Only omission selects the frontmost app. An explicit but malformed
  // identity must never redirect observation or input to the user's app.
  if(!ref) return NSWorkspace.sharedWorkspace.frontmostApplication;
  if(![ref isKindOfClass:NSDictionary.class] || !ref.count) return nil;
  for(id key in ref) {
    id value=ref[key];
    if([key isEqual:@"pid"]) {
      if(![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID()
         || [value doubleValue]<=0 || [value doubleValue]>INT_MAX || [value doubleValue]!=[value intValue]) return nil;
    } else if([key isEqual:@"name"] || [key isEqual:@"bundle_id"]) {
      if(![value isKindOfClass:NSString.class] || ![value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) return nil;
    } else return nil;
  }
  NSString *bundle=ref[@"bundle_id"], *name=ref[@"name"];
  // A name or bundle shared by several running processes (two instances of
  // one browser, a helper and its app) must not resolve to whichever happens
  // to be listed first: that sends observation and input to the wrong window.
  // Refuse like kill_app does; the observed pid disambiguates.
  NSMutableArray<NSRunningApplication *> *hits=[NSMutableArray array];
  for(NSRunningApplication *a in NSWorkspace.sharedWorkspace.runningApplications) {
    if(ref[@"pid"] && a.processIdentifier!=[ref[@"pid"] intValue]) continue;
    if(!ref[@"pid"] && cuIsOwnHelper(a)) continue;
    if(bundle && !matchesName(a.bundleIdentifier,bundle)) continue;
    if(name && !matchesName(a.localizedName,name)) continue;
    [hits addObject:a];
  }
  if(hits.count>1) {
    NSMutableArray *desc=[NSMutableArray array];
    for(NSRunningApplication *a in hits) [desc addObject:[NSString stringWithFormat:@"%@ (pid %d)",a.localizedName?:@"?",a.processIdentifier]];
    @throw [NSException exceptionWithName:@"app" reason:[NSString stringWithFormat:@"several running applications match (%@); pass pid to choose one",[desc componentsJoinedByString:@", "]] userInfo:nil];
  }
  return hits.firstObject;
}
static CGEventRef textEvent(NSString *text, BOOL down) {
  UniChar *chars=calloc(text.length,sizeof(UniChar)); [text getCharacters:chars range:NSMakeRange(0,text.length)];
  CGEventRef event=CGEventCreateKeyboardEvent(NULL,0,down);
#ifdef CU_TEST
  // Simulate physical modifier state without posting a system key event.
  CGEventSetFlags(event,cuTestInheritedTextFlags);
#endif
  // Literal text must not inherit the user's held Command/Control/Option/Shift.
  CGEventSetFlags(event,0);
  CGEventKeyboardSetUnicodeString(event,text.length,chars); free(chars); return event;
}
static BOOL cuTextRole(NSString *role) {
  return [@[@"AXTextField",@"AXTextArea",@"AXComboBox",@"AXSearchField",@"AXSecureTextField",@"AXWebArea"] containsObject:role];
}
/**
 * Whether an element lives inside a browser/webview subtree. Chromium accepts
 * AXSelectedText and AXValue writes on web controls and then ignores them —
 * or, worse, a numeric control coerces the write to empty. Web elements get
 * real keystrokes (after AXFocused) instead of semantic writes.
 */
static BOOL axHasWebAncestor(AXUIElementRef el) {
  // `node` stays an `id` so ARC keeps each ancestor alive through the walk —
  // a raw AXUIElementRef would dangle the moment `parent` is reassigned.
  id node=(__bridge id)el;
  for(int depth=0;node && depth<64;depth++) {
    NSString *role=attr((__bridge AXUIElementRef)node,@"AXRole");
    if([role isEqual:@"AXWebArea"]) return YES;
    id parent=attr((__bridge AXUIElementRef)node,@"AXParent");
    if(!parent || CFEqual((CFTypeRef)parent,(CFTypeRef)node)) break;
    node=parent;
  }
  return NO;
}
// Without a readable selection range only an exact append can be verified.
// Matching length or an already-present suffix is not evidence of delivery.
static BOOL cuTypeVerified(NSString *before, NSString *after, NSString *text) {
  return before && after && [after isEqual:[before stringByAppendingString:text]];
}
static id cuFocusedElement(pid_t pid) {
  AXUIElementRef appEl=AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(appEl,2.0);
  axPrepare(appEl);
  id focused=attr(appEl,@"AXFocusedUIElement");
  CFRelease(appEl);
  return focused;
}
/**
 * Resolve a {windowIndex, path} element target inside the app's AX tree.
 * Returns nil when the window or any path step no longer exists — the same
 * staleness contract as the element-action tools.
 */
static NSArray *cuMenuChildren(AXUIElementRef parent) {
  NSMutableArray *items=[NSMutableArray array];
  for(id child in attr(parent,@"AXChildren")) {
    NSString *role=attr((__bridge AXUIElementRef)child,@"AXRole");
    if([role isEqual:@"AXMenu"]) [items addObjectsFromArray:attr((__bridge AXUIElementRef)child,@"AXChildren")?:@[]];
    else if([role isEqual:@"AXMenuItem"] || [role isEqual:@"AXMenuBarItem"]) [items addObject:child];
  }
  return items;
}
static BOOL cuCloseMenus(pid_t pid, id menu) {
  if(menu) AXUIElementPerformAction((__bridge AXUIElementRef)menu,CFSTR("AXCancel"));
  if(!cuResolveBgPointer()) return !cuMenuOpenForApp(pid);
  for(int i=0;i<32 && cuMenuOpenForApp(pid);i++) {
    for(int down=1;down>=0;down--) {
      CGEventRef e=CGEventCreateKeyboardEvent(NULL,53,down); CGEventSetFlags(e,0);
      cuPidPost(pid,e,NO); CFRelease(e);
    }
    usleep(20000);
  }
  return !cuMenuOpenForApp(pid);
}
static NSDictionary *cuInvokeMenu(AXUIElementRef app, pid_t pid, NSDictionary *args) {
  NSArray *path=args[@"path"];
  if(![path isKindOfClass:NSArray.class] || !path.count) @throw [NSException exceptionWithName:@"args" reason:@"invoke_menu needs a non-empty menu path" userInfo:nil];
  for(id title in path) if(![title isKindOfClass:NSString.class] || ![title length]) @throw [NSException exceptionWithName:@"args" reason:@"menu titles must be non-empty strings" userInfo:nil];
  id menu=attr(app,@"AXMenuBar"),parent=menu;
  if(!menu) @throw [NSException exceptionWithName:@"menu_item_not_found" reason:@"menu_item_not_found: this app has no menu bar" userInfo:nil];
  NSMutableArray *pressed=[NSMutableArray array];
  BOOL finished=NO;
  NSTimeInterval deadline=NSProcessInfo.processInfo.systemUptime+14;
  double yielded=cuYieldToUser(args);
  @try {
    for(NSUInteger level=0;level<path.count;level++) {
      cuCheckCancelled();
      NSString *wanted=path[level],*role=level==0?@"AXMenuBarItem":@"AXMenuItem";
      id found=nil;
      NSTimeInterval until=MIN(deadline,NSProcessInfo.processInfo.systemUptime+1.5);
      do {
        NSMutableArray *matches=[NSMutableArray array];
        for(id item in cuMenuChildren((__bridge AXUIElementRef)parent))
          if([attr((__bridge AXUIElementRef)item,@"AXRole") isEqual:role] && [info((__bridge AXUIElementRef)item,0,0,@[])[@"label"] isEqual:wanted]) [matches addObject:item];
        if(matches.count>1) @throw [NSException exceptionWithName:@"menu_item_ambiguous" reason:[NSString stringWithFormat:@"menu_item_ambiguous: more than one %@ under %@",wanted,[pressed componentsJoinedByString:@" ▸ "]] userInfo:nil];
        found=matches.firstObject;
        if(found || NSProcessInfo.processInfo.systemUptime>=until) break;
        usleep(30000); cuCheckCancelled();
      } while(YES);
      if(!found) @throw [NSException exceptionWithName:@"menu_item_not_found" reason:[NSString stringWithFormat:@"menu_item_not_found: %@ under %@; use the exact observed title",wanted,[pressed componentsJoinedByString:@" ▸ "]] userInfo:nil];
      id enabled=attr((__bridge AXUIElementRef)found,@"AXEnabled");
      if(enabled && ![enabled boolValue]) @throw [NSException exceptionWithName:@"menu_item_disabled" reason:[NSString stringWithFormat:@"menu_item_disabled: %@ is disabled",wanted] userInfo:nil];
      NSArray *actions=cuActions((__bridge AXUIElementRef)found);
      NSString *action=level+1==path.count && [actions containsObject:@"AXPick"]?@"AXPick":@"AXPress";
      if(![actions containsObject:action]) @throw [NSException exceptionWithName:@"action" reason:@"the menu item does not advertise the requested accessibility action" userInfo:nil];
      cuCheckCancelled();
      AXError e=AXUIElementPerformAction((__bridge AXUIElementRef)found,(__bridge CFStringRef)action);
      if(e!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"action" reason:[NSString stringWithFormat:@"menu accessibility action failed: %d",e] userInfo:nil];
      [pressed addObject:wanted]; parent=found;
    }
    finished=YES;
    return @{@"action_sent":@YES,@"strategy":@"a11y",@"route":@"accessibility",@"delivery":@"background",@"menu":pressed,@"front_lease":@NO,@"verified":@NO,@"verification_required":@"observation",@"yield_ms":@(round(yielded))};
  } @catch(NSException *error) {
    BOOL closed=cuCloseMenus(pid,menu);
    @throw [NSException exceptionWithName:error.name reason:[error.reason stringByAppendingFormat:@"; menu cleanup %@; observe before another command",closed?@"confirmed":@"unconfirmed"] userInfo:nil];
  } @finally { if(finished && path.count>1) cuCloseMenus(pid,menu); }
}
static id cuResolvePathTarget(pid_t pid, NSDictionary *t) {
  AXUIElementRef appEl = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(appEl, 2.0);
  axPrepare(appEl);
  NSArray *ws = attr(appEl, @"AXWindows") ?: @[];
  NSInteger wi = [t[@"windowIndex"] integerValue];
  id el = wi == -1 ? attr(appEl, @"AXMenuBar") : wi == -2 ? (__bridge id)appEl : (wi >= 0 && wi < ws.count ? ws[wi] : nil);
  for(NSNumber *i in t[@"path"] ?: @[]) {
    NSArray *kids = el ? attr((__bridge AXUIElementRef)el, @"AXChildren") : nil;
    if(i.unsignedIntegerValue >= kids.count) { el = nil; break; }
    el = kids[i.unsignedIntegerValue];
  }
  CFRelease(appEl);
  return el;
}
static BOOL cuFocusTextTarget(id element) {
  if(AXUIElementSetAttributeValue((__bridge AXUIElementRef)element,kAXFocusedAttribute,kCFBooleanTrue) != kAXErrorSuccess) return NO;
  for(int attempt = 0; attempt < 12; attempt++) {
    usleep(50000);
    cuCheckCancelled();
    if([attr((__bridge AXUIElementRef)element,@"AXFocused") boolValue]) return YES;
  }
  return NO;
}
/**
 * Type into whatever holds focus in the bound app, then prove it landed.
 * Dispatch succeeding is not delivery (a process with no text receiver drops
 * the events silently), so the receipt reports `verified` from the focused
 * control's own value. Failure to verify is reported, not thrown — the events
 * already went out. The one throw is before any event is posted: a focused
 * element that is clearly not a text control.
 */
static NSDictionary *cuType(NSDictionary *args, NSRunningApplication *inputApp, id focused, BOOL simulated) {
  NSString *text=args[@"text"];
  if(![text isKindOfClass:NSString.class]) @throw [NSException exceptionWithName:@"text" reason:@"text must be a string" userInfo:nil];
  NSString *role=focused?attr((__bridge AXUIElementRef)focused,@"AXRole"):nil;
  BOOL secure=[role isEqual:@"AXSecureTextField"] || (focused && [attr((__bridge AXUIElementRef)focused,@"AXSubrole") isEqual:@"AXSecureTextField"]);
  NSString *before=nil;
  // A secure field's value is never read; it verifies as unverifiable.
  if(focused && !secure) { id v=attr((__bridge AXUIElementRef)focused,@"AXValue"); if([v isKindOfClass:NSString.class]) before=v; }
  // Fail closed only on strong evidence: something holds focus and it is
  // clearly not text. No focused element at all still receives the events —
  // some apps take process-directed keys without reporting AX focus.
  if(focused && !cuTextRole(role) && !before)
    @throw [NSException exceptionWithName:@"focus" reason:[NSString stringWithFormat:@"focused element is a %@, not a text control — click or focus a text field first",role?:@"unknown element"] userInfo:nil];
  NSString *expected=nil;
  if(before && focused) {
    id range=attr((__bridge AXUIElementRef)focused,@"AXSelectedTextRange"); CFRange selected;
    if(range && CFGetTypeID((__bridge CFTypeRef)range)==AXValueGetTypeID() && AXValueGetValue((__bridge AXValueRef)range,kAXValueCFRangeType,&selected)
       && selected.location>=0 && selected.length>=0 && selected.location<=before.length && selected.length<=before.length-selected.location)
      expected=[before stringByReplacingCharactersInRange:NSMakeRange(selected.location,selected.length) withString:text];
  }
  // delivery:"events" forces the real keystroke stream. Service-backed
  // fields (a hosted panel's path box) accept an AXSelectedText write and
  // then overwrite it from their own model — the write verifies at read
  // time and reverts on commit. Real key events reach the field's editor.
  BOOL semantic=!simulated && focused && ![args[@"foreground_input"] boolValue] && ![args[@"delivery"] isEqual:@"events"] && cuSettable((__bridge AXUIElementRef)focused,@"AXSelectedText")
    && !axHasWebAncestor((__bridge AXUIElementRef)focused);
  if(semantic) {
    cuCheckCancelled();
    AXError error=AXUIElementSetAttributeValue((__bridge AXUIElementRef)focused,kAXSelectedTextAttribute,(__bridge CFStringRef)text);
    if(error!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"action" reason:[NSString stringWithFormat:@"accessibility text insertion failed: %d; observe before retrying; no keyboard fallback was sent",error] userInfo:nil];
  }
  // One grapheme per event, the way a keyboard delivers them. Batching
  // several into one CGEventKeyboardSetUnicodeString is faster but Electron
  // apps coalesce the pending payload and keep only the final batch, so a
  // typed string silently arrives truncated to its tail.
  //
  // Astral graphemes (surrogate pairs, emoji, flags, ZWJ sequences) are
  // dropped by the WindowServer's key translation whenever the target window
  // is not front-and-visible — measured: occluded Chrome keeps every BMP
  // grapheme and loses 🐳. The window-record channel delivers the real event
  // instead. The trigger is the text, not an occlusion guess: if the string
  // carries any multi-unit grapheme, the whole stream rides the record
  // channel under one lease. Background mode refuses that lease before input;
  // it cannot promise reliable astral text delivery through a focus swap.
  uint32_t typeWin = 0;
  CGRect typeFrame = CGRectZero;
  pid_t typeOwner = 0;
  BOOL needsRecord = NO;
  if(!simulated && !semantic && focused && ![args[@"foreground_input"] boolValue]) {
    for(NSUInteger i = 0; i < text.length && !needsRecord && cuResolveBgPointer();) {
      NSRange r = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(i, 1)];
      if(r.length > 1) needsRecord = YES;
      i = NSMaxRange(r);
    }
    // The focused element may live in a hosted panel whose window belongs to
    // a service, not the app — resolve its real window and owner either way,
    // so process-posted text also reaches the right queue.
    if(cuElementWindow(focused, inputApp.processIdentifier, &typeWin, &typeOwner, nil)
       && cuWindowInfoForNumber(typeWin, &typeFrame, nil)) {
      // A service-owned window's queue is where the panel's field lives;
      // process posting to the app would drop the text. The window route
      // posts to the window's owner and makes the window key there.
      if(typeOwner && typeOwner != inputApp.processIdentifier) needsRecord = YES;
    }
  }
  cuBgLease lease = {0};
  BOOL leasing = NO;
  if(needsRecord && typeWin && cuResolveBgPointer()) {
    NSString *why = nil;
    leasing = cuBgLeaseBegin(inputApp, typeWin, YES, args, &lease, &why);
  }
  // Foreground keystrokes share the user's keyboard: wait for a hardware-
  // input gap once before the stream, not per grapheme — the stream itself
  // is already paced like a fast typist.
  double yieldMs=(!simulated && !semantic && [args[@"foreground_input"] boolValue]) ? cuYieldToUser(args) : 0;
  @try {
    for(NSUInteger i=0;!semantic && i<text.length && !cuCancelled;) {
      if([args[@"foreground_input"] boolValue]) cuRequireForeground(inputApp);
      cuCheckCancelled();
      NSRange range=[text rangeOfComposedCharacterSequencesForRange:NSMakeRange(i,1)];
      NSString *chunk=[text substringWithRange:range];
      if(!simulated) for(int down=1;down>=0;down--) {
        CGEventRef event=textEvent(chunk,down);
        if([args[@"foreground_input"] boolValue]) CGEventPost(kCGHIDEventTap,event);
        else if(leasing) cuPostEventRecord(&lease, event, 3);
        else CGEventPostToPid(typeOwner ? typeOwner : inputApp.processIdentifier,event);
        CFRelease(event);
      }
      i=NSMaxRange(range); usleep(10000);
    }
  } @finally {}
  if(cuCancelled) @throw [NSException exceptionWithName:@"cancelled" reason:@"computer request cancelled" userInfo:nil];
  NSString *after=nil;
  if(focused && !secure) {
#ifdef CU_TEST
    if(simulated) { NSString *s=((NSMutableDictionary *)focused)[@"after"]; if(s) ((NSMutableDictionary *)focused)[@"AXValue"]=s; }
    else
#endif
    usleep(80000);
    id v=attr((__bridge AXUIElementRef)focused,@"AXValue");
    if([v isKindOfClass:NSString.class]) after=v;
  }
  BOOL verified=expected?[after isEqual:expected]:cuTypeVerified(before,after,text);
  NSMutableDictionary *receipt=[@{@"action_sent":@YES,@"chars":@(text.length),@"strategy":semantic?@"a11y-selected-text":@"unicode-events",
                                  @"keyboard_delivery":semantic?@"accessibility":[args[@"foreground_input"] boolValue]?@"foreground-guarded":leasing?@"window-routed":@"process",
                                  @"verified":@(verified),@"focused_role":role?:[NSNull null]} mutableCopy];
  if(leasing) receipt[@"window_focused"]=@YES;
  if(yieldMs>0) receipt[@"yield_ms"]=@(round(yieldMs));
  if(!verified) receipt[@"verification_required"]=@"screenshot";
  return receipt;
}
static NSDictionary *cuReplaceWebText(NSDictionary *args, NSRunningApplication *app, id element) {
  cuRequireFocusControl(args);
  NSString *role = attr((__bridge AXUIElementRef)element,@"AXRole");
  NSString *value = args[@"value"];
  if(![@[@"AXTextField",@"AXTextArea",@"AXComboBox",@"AXSearchField"] containsObject:role] || [attr((__bridge AXUIElementRef)element,@"AXSubrole") isEqual:@"AXSecureTextField"] || ![value isKindOfClass:NSString.class])
    @throw [NSException exceptionWithName:@"value" reason:@"literal web replacement requires an ordinary text field and a string; no write was sent" userInfo:nil];
  if(![role isEqual:@"AXTextArea"] && [value rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound)
    @throw [NSException exceptionWithName:@"value" reason:@"this single-line control cannot preserve line breaks; no write was sent" userInfo:nil];
  uint32_t number = 0;
  CGRect frame = CGRectZero;
  if(!cuResolveBgPointer() || !cuElementWindow(element,app.processIdentifier,&number,nil,nil) || !cuWindowInfoForNumber(number,&frame,nil))
    @throw [NSException exceptionWithName:@"window" reason:@"explicit text target has no input window; observe again; no write was sent" userInfo:nil];
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  NSInteger originalCount = board.changeCount;
  NSMutableArray *saved = [NSMutableArray array];
  for(NSPasteboardItem *item in board.pasteboardItems) {
    NSPasteboardItem *copy = [NSPasteboardItem new];
    for(NSPasteboardType type in item.types) {
      NSData *data = [item dataForType:type];
      if(!data || ![copy setData:data forType:type]) @throw [NSException exceptionWithName:@"clipboard" reason:@"clipboard could not be preserved; no write was sent" userInfo:nil];
    }
    [saved addObject:copy];
  }
  cuBgLease lease = {0};
  NSString *why = nil;
  if(!cuBgLeaseBegin(app,number,YES,args,&lease,&why)) @throw [NSException exceptionWithName:@"bg_dispatch_unavailable" reason:why userInfo:nil];
  BOOL sent = NO, clipboardRestored = YES;
  NSInteger ownedCount = -1;
  NSMutableDictionary *receipt = [@{@"action_sent":@NO,@"verified":@NO,@"strategy":@"window-paste-replace",@"front_lease":@NO,@"role":role,@"window":@{@"id":@(lease.postWin)}} mutableCopy];
  @try {
    cuCheckCancelled();
    cuValidateElementIdentity((__bridge AXUIElementRef)element,args[@"target"]);
    if(board.changeCount != originalCount) @throw [NSException exceptionWithName:@"clipboard" reason:@"clipboard changed before replacement; no text was sent" userInfo:nil];
    sent = YES;
    if(!cuFocusTextTarget(element)) @throw [NSException exceptionWithName:@"focus" reason:@"explicit text target did not acquire focus; no text was sent" userInfo:nil];
    if(board.changeCount != originalCount) @throw [NSException exceptionWithName:@"clipboard" reason:@"clipboard changed before replacement; no text was sent" userInfo:nil];
    ownedCount = [board clearContents];
    BOOL prepared = [board setString:value forType:NSPasteboardTypeString];
    ownedCount = board.changeCount;
    if(!prepared) @throw [NSException exceptionWithName:@"clipboard" reason:@"literal text could not be prepared" userInfo:nil];
    cuWindowChord(&lease,0,kCGEventFlagMaskCommand);
    cuCheckCancelled();
    cuValidateElementIdentity((__bridge AXUIElementRef)element,args[@"target"]);
    if(![attr((__bridge AXUIElementRef)element,@"AXFocused") boolValue]) @throw [NSException exceptionWithName:@"focus" reason:@"text target lost focus before paste" userInfo:nil];
    if(board.changeCount != ownedCount) @throw [NSException exceptionWithName:@"clipboard" reason:@"clipboard changed before paste; no paste was sent" userInfo:nil];
    cuWindowChord(&lease,9,kCGEventFlagMaskCommand);
    NSUInteger stable = 0;
    for(int attempt = 0; attempt < 15; attempt++) {
      usleep(80000);
      cuCheckCancelled();
      id fresh = cuResolvePathTarget(app.processIdentifier,args[@"target"]);
      if(!fresh || !CFEqual((__bridge CFTypeRef)fresh,(__bridge CFTypeRef)element)) @throw [NSException exceptionWithName:@"stale" reason:@"text target changed after delivery" userInfo:nil];
      cuValidateElementIdentity((__bridge AXUIElementRef)fresh,args[@"target"]);
      id after = attr((__bridge AXUIElementRef)fresh,@"AXValue");
      receipt[@"after"] = after ?: NSNull.null;
      stable = [after isEqual:value] ? stable + 1 : 0;
      if(stable >= 3) { receipt[@"verified"] = @YES; break; }
    }
  } @catch(NSException *error) {
    receipt[@"error"] = error.reason ?: @"text replacement did not complete";
  } @finally {
    if(ownedCount >= 0) {
      clipboardRestored = board.changeCount == ownedCount;
      if(clipboardRestored) { [board clearContents]; if(saved.count) clipboardRestored = [board writeObjects:saved]; }
    }
  }
  receipt[@"action_sent"] = @(sent);
  receipt[@"clipboard_restored"] = @(clipboardRestored);
  if(![receipt[@"verified"] boolValue]) { receipt[@"outcome_unknown"] = @(sent); receipt[@"verification_required"] = @"observation"; }
  return receipt;
}
static NSDictionary *windowAtPoint(NSArray *windows, CGPoint p) {
    NSMutableArray *skipped=[NSMutableArray array];
    for(NSDictionary *w in windows) {          // front to back
      CGRect b;
      if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds],&b)) continue;
      if(!CGRectContainsPoint(b,p)) continue;
      pid_t owner=[w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
      NSString *name=w[(__bridge NSString *)kCGWindowOwnerName]?:@"";
      NSNumber *alpha=w[(__bridge NSString *)kCGWindowAlpha], *layer=w[(__bridge NSString *)kCGWindowLayer]?:@0;
      // Visible floating windows occlude input just like normal windows.
      if(alpha && [alpha doubleValue]<=0) { [skipped addObject:@{@"owner":name,@"why":@"transparent"}]; continue; }
      return @{@"found":@YES,@"owner_pid":@(owner),@"owner_name":name,
               @"window_id":w[(__bridge NSString *)kCGWindowNumber]?:@0,@"layer":layer,
               @"skipped":skipped};
    }
    return @{@"found":@NO,@"skipped":skipped};
}

static id execute(NSDictionary *p) {
  NSString *tool=p[@"tool"]; NSDictionary *args=p[@"args"]?:@{};
  // The user's hardware cursor is never driven: there is no route that posts
  // mouse events to the HID tap, warps the cursor or holds its buttons.
  if([@[@"pointer_sequence",@"release_input"] containsObject:tool])
    @throw [NSException exceptionWithName:@"real_pointer_refused" reason:@"real_pointer_refused: Computer Use never drives the user's cursor; pointer input goes to the bound app's window (bg_pointer)" userInfo:nil];
  if([@[@"bg_key",@"bg_pointer"] containsObject:tool]) cuRequireLease(args);
  cuOwnerPipe=[args[@"owner_pipe"] boolValue];
  BOOL mutates=[@[@"type",@"key_event",@"bg_key",@"mouse_event",@"scroll",@"bg_pointer",@"set_value",@"focus_element",@"select_text",@"perform_action",@"click_element",@"scroll_element",@"invoke_menu"] containsObject:tool]
    || ([tool isEqual:@"hit_test"] && [args[@"perform"] boolValue])
    || ([tool isEqual:@"app_info"] && [args[@"activate"] boolValue]);
  if([tool isEqual:@"key_event"] && ![args[@"down"] boolValue] && [args[@"owned_release"] boolValue]) {
    if(!AXIsProcessTrusted()) @throw [NSException exceptionWithName:@"permission" reason:@"Accessibility permission is missing" userInfo:nil];
    cuLockInput();
    // Release a confirmed/ambiguous press even if its original app has exited.
    return cuPostKey(args,[args[@"input_app_ref"][@"pid"] intValue]);
  }
  cuCheckCancelled();
  if([tool isEqual:@"input_capabilities"]) return @{@"pid_input":@1,@"agent":@1,@"screen_lock_check":@1,@"input_lease":@1,@"owner_pipe":@YES,@"record_owner_pipe":@1,@"window_ocr":@1,@"element_identity":@1,@"background_actions":@1,@"background_focus_guard":@1,@"focus_lease":@1,@"focused_control":@1,@"window_record":@(cuResolveBgPointer()?1:0),@"observed_window_input":@1,@"targeted_keys":@1,@"literal_text_replace":@1,@"pointer_context":@1,@"pointer_owner_validation":@1,@"menu_path":@1};
  if([tool isEqual:@"front_lease_watchdog"]) {
    long long remaining = [args[@"deadline"] longLongValue] - (long long)([NSDate new].timeIntervalSince1970 * 1000);
    if(remaining > 0 && remaining < 30000) usleep((useconds_t)remaining * 1000);
    NSData *data = [NSData dataWithContentsOfFile:cuFrontLeaseFile()];
    NSDictionary *held = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if([held isKindOfClass:NSDictionary.class] && [held[@"token"] isEqual:args[@"token"]]) cuFrontLeaseRestoreIfHeld();
    return @{@"ok":@YES};
  }
  if([tool isEqual:@"record"]) return cuRecord(args);
  if([tool isEqual:@"recognize_text"]) return cuRecognizeText(args[@"file"]);
#ifdef CU_TEST
  if([tool isEqual:@"inspect_focus_control"]) { cuRequireLease(args); return @{@"allowed":@YES}; }
  if([tool isEqual:@"inspect_user_yield"]) {
    cuTestIdleSeconds=args[@"idle_seconds"];
    if([args[@"cancelled"] boolValue]) cuCancelled=1;
    return @{@"yield_ms":@(cuYieldToUser(args))};
  }
  if([tool isEqual:@"inspect_enhanced_ui_frame"]) {
    // Drives the same cuWriteWindowFrame that set_window_frame uses, against a
    // fake app and window that log every write with the enhanced-UI state.
    NSMutableDictionary *app=[@{@"writes":[NSMutableArray array]} mutableCopy];
    if(args[@"enhanced"]) app[@"AXEnhancedUserInterface"]=args[@"enhanced"];
    NSMutableDictionary *win=[@{@"app":app} mutableCopy];
    if([args[@"refuse"] boolValue]) win[@"refuse"]=@YES;
    CGRect before=CGRectMake(0,0,1100,800), after=before;
    NSString *error=nil;
    @try {
      after=cuWriteWindowFrame((__bridge AXUIElementRef)app,(__bridge AXUIElementRef)win,CGRectMake(200,120,1600,900),before,NULL,NULL);
    } @catch(NSException *e) { error=e.reason; }
    return @{@"writes":app[@"writes"],@"enhanced":app[@"AXEnhancedUserInterface"]?:NSNull.null,@"error":error?:NSNull.null,
             @"after":@{@"x":@(after.origin.x),@"y":@(after.origin.y),@"w":@(after.size.width),@"h":@(after.size.height)}};
  }
  if([tool isEqual:@"inspect_click_action"]) return @{@"action":cuClickAction((__bridge AXUIElementRef)args[@"element"],[args[@"context"] boolValue])?:NSNull.null};
  if([tool isEqual:@"inspect_element_identity"]) {
    cuValidateElementIdentity((__bridge AXUIElementRef)args[@"element"],args[@"target"]);
    return @{@"identity_matches":@YES};
  }
  if([tool isEqual:@"inspect_window_at_point"]) return windowAtPoint(args[@"windows"],CGPointMake([args[@"x"] doubleValue],[args[@"y"] doubleValue]));
  if([tool isEqual:@"inspect_window_match"]) {
    NSDictionary *b=args[@"bounds"];
    CGRect bounds=CGRectMake([b[@"x"] doubleValue],[b[@"y"] doubleValue],[b[@"w"] doubleValue],[b[@"h"] doubleValue]);
    return capturableWindow(args[@"windows"],[args[@"pid"] intValue],@"Fixture",bounds);
  }
  if([tool isEqual:@"inspect_observation"]) {
    BOOL truncated=NO;
    NSArray *elements=observeElements((__bridge AXUIElementRef)args[@"app"],args[@"windows"]?:@[],args,NO,&truncated);
    return @{@"elements":elements,@"truncated":@(truncated)};
  }
  if([tool isEqual:@"test_input_lease"]) {
    cuTestLockDir=args[@"lock_dir"]; cuLockInput();
    cuTestReleaseFile=args[@"release_file"];
    if([args[@"work_ms"] intValue]>0) {
      cuPrint(@{@"action_sent":@YES,@"input_lease":@YES});
      for(int elapsed=0;elapsed<[args[@"work_ms"] intValue];elapsed+=20) { cuCheckCancelled(); usleep(20000); }
    }
    return @{@"action_sent":@YES};
  }
  if([tool isEqual:@"inspect_text_event"]) {
    cuTestInheritedTextFlags=[args[@"inherited_flags"] unsignedLongLongValue];
    CGEventRef event=textEvent(args[@"text"],YES); UniChar chars[4096]; UniCharCount length=0;
    CGEventKeyboardGetUnicodeString(event,4096,&length,chars); CGEventFlags flags=CGEventGetFlags(event); CFRelease(event);
    return @{@"text":[NSString stringWithCharacters:chars length:length],@"flags":@(flags)};
  }
  // Drives the real typing logic against a fixture focused element instead of
  // a live app: `after` is the value the element reports once the text lands,
  // which a fixture omits to model an app that swallows the events.
  if([tool isEqual:@"inspect_type"]) {
    id fixture=args[@"focused"];
    return cuType(args, nil, [fixture isKindOfClass:NSDictionary.class]?[fixture mutableCopy]:nil, YES);
  }
#endif
  if([tool isEqual:@"permissions"]) return @{@"trusted":@(AXIsProcessTrusted())};
  if([tool isEqual:@"list_apps"]) {
    NSMutableArray *apps=[NSMutableArray array];
    for(NSRunningApplication *a in NSWorkspace.sharedWorkspace.runningApplications) {
      if(cuIsOwnHelper(a)) continue;
      NSInteger policy = a.activationPolicy;
      NSString *policyName = (policy >= 0 && policy <= 2) ? @[@"regular",@"accessory",@"prohibited"][policy] : @"unknown";
      [apps addObject:@{@"name":a.localizedName?:@"",@"pid":@(a.processIdentifier),@"bundle_id":a.bundleIdentifier?:@"",@"frontmost":@(a.active),@"hidden":@(a.hidden),@"activation_policy":policyName}];
    }
    return @{@"apps":apps};
  }
  if([tool isEqual:@"displays"]) {
    uint32_t n=0; CGGetActiveDisplayList(0,NULL,&n); CGDirectDisplayID ids[n]; CGGetActiveDisplayList(n,ids,&n);
    NSMutableArray *out=[NSMutableArray array];
    for(uint32_t i=0;i<n;i++){ CGRect b=CGDisplayBounds(ids[i]); CGDisplayModeRef mode=CGDisplayCopyDisplayMode(ids[i]);
      size_t w=CGDisplayModeGetPixelWidth(mode),h=CGDisplayModeGetPixelHeight(mode); CGDisplayModeRelease(mode);
      [out addObject:@{@"index":@(i+1),@"id":@(ids[i]),@"main":@(ids[i]==CGMainDisplayID()),@"points":@{@"x":@(b.origin.x),@"y":@(b.origin.y),@"w":@(b.size.width),@"h":@(b.size.height)},@"pixels":@{@"w":@(w),@"h":@(h)},@"scale":@(w/b.size.width)}]; }
    return out;
  }
  if([tool isEqual:@"preview_notify"]) {
    [[NSDistributedNotificationCenter defaultCenter] postNotificationName:@"net.codewhale.computer-use.preview" object:nil userInfo:args deliverImmediately:YES];
    return @{@"updated":@YES};
  }
  if([tool isEqual:@"window_info"]) {
    NSRunningApplication *a=resolve(args[@"app_ref"]?:args[@"input_app_ref"]);
    if(!a) @throw [NSException exceptionWithName:@"app" reason:@"application not found" userInfo:nil];
    AXUIElementRef ax=AXUIElementCreateApplication(a.processIdentifier);
    axPrepare(ax);
    NSArray *axWindows=attr(ax,@"AXWindows");
    NSInteger index=[args[@"window_id"] integerValue];
    CGRect preferred;
    BOOL integerIndex=!args[@"window_id"] || ([args[@"window_id"] isKindOfClass:NSNumber.class] && [args[@"window_id"] doubleValue]==index);
    BOOL valid=integerIndex && index>=0 && index<axWindows.count && cuFrame((__bridge AXUIElementRef)axWindows[index],&preferred);
    CFRelease(ax);
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll,kCGNullWindowID));
    if(!valid && [args[@"allow_off_space"] boolValue] && index==0) {
      for(NSDictionary *w in windows) {
        if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue]!=a.processIdentifier || [w[(__bridge NSString *)kCGWindowLayer] intValue]!=0) continue;
        CGRect b; if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds],&b) || b.size.width<40 || b.size.height<40) continue;
        uint32_t wid=[w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
        if(![cuWindowOnCurrentSpace(wid) isEqual:@NO]) continue;
        return @{@"window_id":@(wid),@"name":a.localizedName?:@"App",@"pid":@(a.processIdentifier),@"off_space":@YES,
                 @"title":w[(__bridge NSString *)kCGWindowName]?:@"",@"points":@{@"x":@(b.origin.x),@"y":@(b.origin.y),@"w":@(b.size.width),@"h":@(b.size.height)}};
      }
    }
    if(!valid) @throw [NSException exceptionWithName:@"window" reason:@"the selected app window has no accessibility geometry; call list_windows for a valid window index" userInfo:nil];
    NSMutableDictionary *result = [capturableWindow(windows,a.processIdentifier,a.localizedName,preferred) mutableCopy];
    result[@"pid"] = @(a.processIdentifier);
    return result;
  }
  // Which application owns the point a pointer event would land on. A global
  // pointer event goes to whatever is on top, so this is what stops a click
  // meant for the agent's app from landing in the user's window.
  if([tool isEqual:@"window_at_point"]) {
    CGPoint p=CGPointMake([args[@"x"] doubleValue],[args[@"y"] doubleValue]);
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    return windowAtPoint(windows,p);
  }
  if([tool isEqual:@"app_info"]) {
    NSRunningApplication *a=resolve(args[@"app_ref"]);
    if(!a) @throw [NSException exceptionWithName:@"app" reason:@"application not found" userInfo:nil];
    if([a.bundleIdentifier isEqual:@"net.codewhale.computer-use"] && [args[@"activate"] boolValue]) @throw [NSException exceptionWithName:@"protected" reason:@"Computer Use safety controls belong to the user." userInfo:nil];
    double yieldMs=0;
    if([args[@"activate"] boolValue]) {
      cuLockInput();
      // Activation takes the person's foreground — wait for a hardware-
      // input gap first so a mid-type activation cannot swallow their
      // next keystrokes.
      yieldMs=cuYieldToUser(args);
    }
    cuCheckCancelled();
    if([args[@"activate"] boolValue] && !axActivate(a.processIdentifier)) [a activateWithOptions:0];
    if([args[@"activate"] boolValue]) for(int i=0;i<120;i++) {
      cuCheckCancelled();
      // NSWorkspace only refreshes its frontmost view through run-loop
      // notifications; a one-shot helper that never services them reads a
      // stale answer for seconds and misreports a working activation.
      [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]];
      if(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==a.processIdentifier) break;
    }
    NSMutableDictionary *info=[@{@"found":@YES,@"name":a.localizedName?:@"",@"pid":@(a.processIdentifier),@"bundle_id":a.bundleIdentifier?:@"",@"frontmost":@(a.active)} mutableCopy];
    if(yieldMs>0) info[@"yield_ms"]=@(round(yieldMs));
    return info;
  }
  if([tool isEqual:@"kill_app"]) {
    NSString *bundle=args[@"bundle_id"], *name=args[@"name"]; NSNumber *pidNum=args[@"pid"];
    if(!bundle && !name && !pidNum) @throw [NSException exceptionWithName:@"args" reason:@"kill_app needs name, bundle_id or pid" userInfo:nil];
    if(pidNum && (![pidNum isKindOfClass:NSNumber.class] || [pidNum doubleValue]<=0 || [pidNum doubleValue]>INT_MAX || [pidNum doubleValue]!=[pidNum intValue])) @throw [NSException exceptionWithName:@"args" reason:@"kill_app pid must be a positive integer" userInfo:nil];
    // A name that matches two running apps must not guess which one to end.
    NSMutableArray *hits=[NSMutableArray array];
    for(NSRunningApplication *a in NSWorkspace.sharedWorkspace.runningApplications) {
      if(pidNum && a.processIdentifier!=[pidNum intValue]) continue;
      if(bundle && !matchesName(a.bundleIdentifier?:@"",bundle)) continue;
      if(name && !matchesName(a.localizedName?:@"",name)) continue;
      [hits addObject:a];
    }
    if(!hits.count) @throw [NSException exceptionWithName:@"app" reason:@"application not found" userInfo:nil];
    if(hits.count>1) {
      NSMutableArray *desc=[NSMutableArray array];
      for(NSRunningApplication *a in hits) [desc addObject:[NSString stringWithFormat:@"%@ (pid %d)",a.localizedName?:@"?",a.processIdentifier]];
      @throw [NSException exceptionWithName:@"app" reason:[NSString stringWithFormat:@"several running applications match (%@); pass pid to choose one",[desc componentsJoinedByString:@", "]] userInfo:nil];
    }
    NSRunningApplication *target=hits[0];
    pid_t tp=target.processIdentifier;
    // The helper, its host (the daemon or MCP server), and the app bundle that
    // owns this process must never be terminable through the agent surface.
    if([(target.bundleIdentifier?:@"") isEqual:@"net.codewhale.computer-use"] || tp==getpid() || tp==getppid())
      @throw [NSException exceptionWithName:@"protected" reason:@"the Computer Use helper and its host cannot be terminated by this plugin" userInfo:nil];
    [target terminate];
    for(int i=0;i<60 && !target.isTerminated;i++) { cuCheckCancelled(); [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; }
    BOOL forced=NO;
    if(!target.isTerminated && [args[@"force"] boolValue]) {
      [target forceTerminate]; forced=YES;
      for(int i=0;i<40 && !target.isTerminated;i++) { cuCheckCancelled(); [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]; }
    }
    return @{@"killed":@(target.isTerminated),@"pid":@(tp),@"name":target.localizedName?:@"",@"force_used":@(forced)};
  }
  if([tool isEqual:@"installed_apps"]) {
    // Installed catalog: the apps a person could open, running or not. Root +
    // one level of subdirectories (e.g. /Applications/Utilities); bundle
    // identity comes from the bundle itself, never from the directory name.
    NSMutableDictionary *running=@{}.mutableCopy;
    for(NSRunningApplication *a in NSWorkspace.sharedWorkspace.runningApplications) {
      if(a.bundleIdentifier) running[a.bundleIdentifier]=@(a.processIdentifier);
    }
    NSMutableDictionary *byId=@{}.mutableCopy;
    NSFileManager *fm=NSFileManager.defaultManager;
    NSArray *roots=@[@"/Applications", @"/System/Applications", [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"]];
    for(NSString *root in roots) {
      cuCheckCancelled();
      NSString *top=[root stringByResolvingSymlinksInPath];
      NSMutableArray *dirs=[NSMutableArray array]; [dirs addObject:top];
      for(NSString *sub in ([fm contentsOfDirectoryAtPath:top error:nil]?:@[])) {
        if([sub hasPrefix:@"."]||[sub hasSuffix:@".app"]) continue;
        NSString *p=[top stringByAppendingPathComponent:sub];
        BOOL isDir=NO;
        if([fm fileExistsAtPath:p isDirectory:&isDir] && isDir) [dirs addObject:p];
      }
      for(NSString *dir in dirs) {
        for(NSString *item in ([fm contentsOfDirectoryAtPath:dir error:nil]?:@[])) {
          if(![item hasSuffix:@".app"]) continue;
          NSString *p=[dir stringByAppendingPathComponent:item];
          NSBundle *b=[NSBundle bundleWithPath:p];
          NSString *bid=b.bundleIdentifier;
          if(!bid || byId[bid]) continue;
          NSString *name=[b objectForInfoDictionaryKey:@"CFBundleDisplayName"];
          if(!name.length) name=[b objectForInfoDictionaryKey:@"CFBundleName"];
          if(!name.length) name=[item stringByDeletingPathExtension];
          byId[bid]=@{@"name":name,@"bundle_id":bid,@"path":p}; 
        }
      }
    }
    NSMutableArray *out=[NSMutableArray array];
    for(NSString *bid in byId) {
      NSMutableDictionary *e=[byId[bid] mutableCopy];
      NSNumber *pid=running[bid];
      e[@"running"]=(pid!=nil)?@YES:@NO;
      if(pid) e[@"pid"]=pid;
      [out addObject:e];
    }
    [out sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b){ return [a[@"name"] localizedCaseInsensitiveCompare:b[@"name"]]; }];
    return @{@"apps":out,@"count":@(out.count)};
  }
  if([tool isEqual:@"set_window_frame"]) {
    NSRunningApplication *a=resolve(args[@"app_ref"]);
    if(!a) @throw [NSException exceptionWithName:@"app" reason:@"application not found" userInfo:nil];
    NSDictionary *frame=args[@"frame"];
    double fx=NAN,fy=NAN,fw=NAN,fh=NAN;
    if([frame isKindOfClass:NSDictionary.class]) {
      fx=[frame[@"x"] doubleValue]; fy=[frame[@"y"] doubleValue];
      fw=[frame[@"w"] doubleValue]; fh=[frame[@"h"] doubleValue];
    }
    if(!isfinite(fx)||!isfinite(fy)||!isfinite(fw)||!isfinite(fh)||fw<=0||fh<=0)
      @throw [NSException exceptionWithName:@"args" reason:@"set_window_frame needs frame {x,y,w,h} with positive w/h" userInfo:nil];
    NSNumber *idxNum=args[@"window_id"];
    if(![idxNum isKindOfClass:NSNumber.class] || [idxNum doubleValue]!=[idxNum intValue] || [idxNum intValue]<0)
      @throw [NSException exceptionWithName:@"args" reason:@"set_window_frame needs window_id (a non-negative window index from list_windows)" userInfo:nil];
    AXUIElementRef app=AXUIElementCreateApplication(a.processIdentifier);
    axPrepare(app);
    NSArray *windows=attr(app,@"AXWindows");
    NSInteger idx=[idxNum intValue];
    if(idx>=(NSInteger)windows.count) { CFRelease(app); @throw [NSException exceptionWithName:@"window" reason:@"window_id is out of range; call list_windows for valid indices" userInfo:nil]; }
    AXUIElementRef win=(__bridge AXUIElementRef)windows[idx];
    CGRect before=CGRectNull; cuFrame(win,&before);
    cuCheckCancelled();
    AXError pe=kAXErrorFailure, se=kAXErrorFailure;
    CGRect after=before;
    @try { after=cuWriteWindowFrame(app,win,CGRectMake(fx,fy,fw,fh),before,&pe,&se); }
    @finally { CFRelease(app); }
    BOOL verified = fabs(after.origin.x-fx)<1 && fabs(after.origin.y-fy)<1 && fabs(after.size.width-fw)<1 && fabs(after.size.height-fh)<1;
    NSMutableDictionary *done=[@{@"action_sent":@YES,@"window_id":@(idx),
             @"before":@{@"x":@(before.origin.x),@"y":@(before.origin.y),@"w":@(before.size.width),@"h":@(before.size.height)},
             @"after":@{@"x":@(after.origin.x),@"y":@(after.origin.y),@"w":@(after.size.width),@"h":@(after.size.height)},
             @"verified":@(verified)} mutableCopy];
    if(pe!=kAXErrorSuccess || se!=kAXErrorSuccess) {
      done[@"ax_errors"]=@{@"position":@(pe),@"size":@(se)};
      done[@"note"]=@"the app constrained or refused part of the frame (minimum sizes and fixed-size windows are common); the after readback is what actually happened";
    }
    return done;
  }
  NSRunningApplication *inputApp=nil;
  if([@[@"type",@"key_event",@"bg_key",@"mouse_event",@"scroll",@"hit_test",@"bg_pointer",@"pointer_context",@"focused_control"] containsObject:tool]) {
    if(![args[@"input_app_ref"] isKindOfClass:NSDictionary.class]) @throw [NSException exceptionWithName:@"focus" reason:@"open_application first to bind the input destination" userInfo:nil];
    inputApp=resolve(args[@"input_app_ref"]);
    if(!inputApp || inputApp.terminated) @throw [NSException exceptionWithName:@"focus" reason:@"input application is no longer running; open_application again" userInfo:nil];
    if([inputApp.bundleIdentifier isEqual:@"net.codewhale.computer-use"]) @throw [NSException exceptionWithName:@"protected" reason:@"Computer Use safety controls belong to the user." userInfo:nil];
  }
  if((mutates || [@[@"get_app_state",@"window_info",@"list_windows",@"pointer_context"] containsObject:tool]) && cuScreenLocked())
    @throw [NSException exceptionWithName:@"screen_locked" reason:@"screen_locked: the Mac is locked; apps cannot be read or controlled until the person unlocks it. No input was sent." userInfo:nil];
  // A held menu lease is given back before fresh raw input or an explicit
  // activation; AX element actions (the pick itself) leave it alone.
  if([@[@"bg_pointer",@"type",@"key_event",@"bg_key"] containsObject:tool]
     || ([tool isEqual:@"app_info"] && [args[@"activate"] boolValue]))
    cuFrontLeaseRestoreIfHeld();
  if(mutates) { cuCheckCancelled(); cuLockInput(); }
  if(!AXIsProcessTrusted()) @throw [NSException exceptionWithName:@"permission" reason:@"Accessibility permission is missing for Codewhale Computer Use (or the direct host)." userInfo:nil];
  if([tool isEqual:@"focused_control"]) {
    AXUIElementRef appEl=AXUIElementCreateApplication(inputApp.processIdentifier);
    AXUIElementSetMessagingTimeout(appEl,2.0);
    axPrepare(appEl);
    CFTypeRef value=NULL;
    AXError err=AXUIElementCopyAttributeValue(appEl,kAXFocusedUIElementAttribute,&value);
    CFRelease(appEl);
    if(err==kAXErrorNoValue || err==kAXErrorAttributeUnsupported || err==kAXErrorNotImplemented || (err==kAXErrorSuccess && !value)) return @{@"control":NSNull.null};
    if(err!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"focused_control" reason:[NSString stringWithFormat:@"focused_control_unknown: the focused control could not be read (%d)",err] userInfo:nil];
    id focused=CFBridgingRelease(value);
    AXUIElementRef el=(__bridge AXUIElementRef)focused;
    id role=attr(el,@"AXRole"), title=attr(el,@"AXTitle"), desc=attr(el,@"AXDescription");
    BOOL hasTitle=[title isKindOfClass:NSString.class] && [title length];
    BOOL hasDesc=[desc isKindOfClass:NSString.class] && [desc length];
    return @{@"control":@{@"role":[role isKindOfClass:NSString.class]?role:NSNull.null,
                          @"label":hasTitle?title:(hasDesc?desc:NSNull.null),
                          @"description":hasDesc?desc:NSNull.null}};
  }
  if([tool isEqual:@"type"]) {
    id focused = cuFocusedElement(inputApp.processIdentifier);
    NSDictionary *tt = args[@"target"];
    // An explicit element target overrides app-level focus for delivery
    // routing — a hosted panel's field is never the app's AXFocusedUIElement.
    if([tt isKindOfClass:NSDictionary.class]) {
      id el = cuResolvePathTarget(inputApp.processIdentifier, tt);
      if(!el) @throw [NSException exceptionWithName:@"stale" reason:@"element is no longer available; observe again" userInfo:nil];
      cuValidateElementIdentity((__bridge AXUIElementRef)el,tt);
      focused = el;
    }
    return cuType(args, inputApp, focused, NO);
  }
  if([tool isEqual:@"key_event"]) {
    double yieldMs=0;
    if([args[@"foreground_input"] boolValue] && [args[@"down"] boolValue]) {
      cuRequireForeground(inputApp);
      // Real hardware taps land between the person's keystrokes unless we
      // wait for a gap first; the up event is part of our own press and
      // must not wait.
      yieldMs=cuYieldToUser(args);
      cuRequireForeground(inputApp);
    }
    cuCheckCancelled();
    id result=cuPostKey(args,inputApp.processIdentifier);
    if(yieldMs>0) { NSMutableDictionary *r=[result mutableCopy]; r[@"yield_ms"]=@(round(yieldMs)); result=r; }
    if([args[@"input_lease"] boolValue] && [args[@"down"] boolValue]) { cuLeaseKey=args; cuLeasePid=inputApp.processIdentifier; cuLeaseApp=inputApp; }
    return result;
  }
  // A key chord with modifier flags through the window-record channel: menu
  // key equivalents (cmd+a, cmd+shift+g) only validate against a key window,
  // which the lease provides. Used by background select-all/replace flows.
  if([tool isEqual:@"bg_key"]) {
    if(!cuResolveBgPointer())
      @throw [NSException exceptionWithName:@"bg_dispatch_unavailable" reason:@"window-routed background keys are unavailable; no input was sent" userInfo:nil];
    // The window to post into: an explicit element target's window when the
    // caller names one (a panel's field, say), otherwise the focused
    // element's. An app-level AXFocusedUIElement always reports the app's own
    // window focus, which misses hosted panels entirely.
    id anchor = nil;
    NSDictionary *t = args[@"target"];
    if([t isKindOfClass:NSDictionary.class]) {
      anchor = cuResolvePathTarget(inputApp.processIdentifier, t);
      if(!anchor) @throw [NSException exceptionWithName:@"stale" reason:@"element is no longer available; observe again" userInfo:nil];
      cuValidateElementIdentity((__bridge AXUIElementRef)anchor,t);
    } else anchor = cuFocusedElement(inputApp.processIdentifier);
    uint32_t keyWin = 0;
    CGRect keyFrame = CGRectZero;
    pid_t keyOwner = 0;
    NSString *winRole = nil;
    if(anchor) cuElementWindow(anchor, inputApp.processIdentifier, &keyWin, &keyOwner, &winRole)
      && cuWindowInfoForNumber(keyWin, &keyFrame, nil);
    if(!keyWin) @throw [NSException exceptionWithName:@"focus" reason:@"no focused window for a window-routed key; focus a control first" userInfo:nil];
    cuBgLease lease;
    NSString *why = nil;
    if(!cuBgLeaseBegin(inputApp, keyWin, YES, args, &lease, &why))
      @throw [NSException exceptionWithName:@"bg_dispatch_unavailable" reason:why userInfo:nil];
    // Keys go to the app's key window; a key meant for this window must not
    // land in a sibling (a Find panel, another document), so the switch is
    // read back and the chord refused when it did not hold.
    if(lease.postPid == lease.targetPid && !cuAppKeyWindowIs(lease.targetPid, lease.postWin)) {
      cuPostWindowRecord(&lease.postPSN, lease.postWin, 0x01);
      cuPostWindowRecord(&lease.postPSN, lease.postWin, 0x02);
      usleep(200000);
      if(!cuAppKeyWindowIs(lease.targetPid, lease.postWin))
        @throw [NSException exceptionWithName:@"key_window_unconfirmed" reason:@"key_window_unconfirmed: the target window could not be confirmed as the app's key window, so no key was sent (it could have reached another window of the same app). Close the other window, or use activate:true." userInfo:nil];
    }
    @try {
      NSString *role = anchor ? attr((__bridge AXUIElementRef)anchor,@"AXRole") : nil;
      if(t && cuTextRole(role) && ![role isEqual:@"AXWebArea"]) {
        if(!cuFocusTextTarget(anchor)) @throw [NSException exceptionWithName:@"focus" reason:@"explicit key target could not be focused; no key was sent" userInfo:nil];
      }
      if(t) cuValidateElementIdentity((__bridge AXUIElementRef)anchor,t);
      cuWindowChord(&lease,[args[@"code"] unsignedShortValue],[args[@"flags"] unsignedLongLongValue]);
    } @finally {}
    NSMutableDictionary *receipt = [@{@"action_sent":@YES, @"strategy":@"pid-routed", @"keyboard_delivery":@"process", @"front_lease":@NO,@"window":@{@"id":@(lease.postWin)}} mutableCopy];
    if(winRole) receipt[@"window_role"] = winRole;
    if(lease.postPid != lease.targetPid) receipt[@"window_owner_pid"] = @(lease.postPid);
    return receipt;
  }
  if([tool isEqual:@"mouse_event"]) {
    CGPoint p=CGPointMake([args[@"x"] doubleValue],[args[@"y"] doubleValue]);
    CGEventRef event=CGEventCreateMouseEvent(NULL,[args[@"type"] unsignedIntValue],p,[args[@"button"] unsignedIntValue]);
    CGEventSetIntegerValueField(event,kCGMouseEventClickState,[args[@"clickState"] longLongValue]);
    // Address the window as well as the process using public event fields.
    // Dispatch is not delivery: a toolkit may still discard these events.
    // This primitive needs effect readback before a caller can rely on it.
    if([args[@"windowNumber"] longLongValue]>0) {
      CGEventSetIntegerValueField(event,kCGMouseEventWindowUnderMousePointer,[args[@"windowNumber"] longLongValue]);
      CGEventSetIntegerValueField(event,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,[args[@"windowNumber"] longLongValue]);
    }
    cuCheckCancelled();
    CGEventPostToPid(inputApp.processIdentifier,event); CFRelease(event); return @{@"action_sent":@YES};
  }
  // Accessibility-first coordinate action: resolve the point against the bound
  // application's AX tree and press the element it names. Callers fall back to
  // raw CGEvents when this reports found=NO, so it must fail closed rather than
  // guess: a point owned by another process, or a point that only lands on a
  // container, is not a press.
  if([tool isEqual:@"hit_test"]) {
    CGPoint p=CGPointMake([args[@"x"] doubleValue],[args[@"y"] doubleValue]);
    AXUIElementRef appEl=AXUIElementCreateApplication(inputApp.processIdentifier);
    AXUIElementSetMessagingTimeout(appEl,2.0);
    axPrepare(appEl);
    uint32_t observedNumber = 0;
    CGRect observedFrame = CGRectZero;
    BOOL pinned = args[@"observed_window"] != nil;
    if(pinned) cuObservedWindow(args[@"observed_window"],inputApp.processIdentifier,p,&observedNumber,&observedFrame);
    AXUIElementRef raw=NULL;
    AXError err=pinned ? kAXErrorNoValue : AXUIElementCopyElementAtPosition(appEl,(float)p.x,(float)p.y,&raw);
    id hit=nil;
    if(err==kAXErrorSuccess && raw) {
      pid_t owner=0;
      if(AXUIElementGetPid(raw,&owner)==kAXErrorSuccess && owner==inputApp.processIdentifier) hit=CFBridgingRelease(raw);
      else CFRelease(raw); // Another app may cover a background window. Search only our own tree below.
    }

    id chosen=nil;
    BOOL insideSheet=NO;
    NSString *operation=args[@"operation"]?:@"click";
    BOOL scrolling=[operation hasPrefix:@"scroll"];
    // 1. The element under the point, or the nearest ancestor that can be
    //    pressed — a label inside a button is the common case.
    for(id cur=hit; cur && !chosen;) {
      AXUIElementRef el=(__bridge AXUIElementRef)cur;
      id role=attr(el,@"AXRole");
      if([role isEqual:@"AXSheet"]) insideSheet=YES;
      if([role isEqual:@"AXWindow"] || [role isEqual:@"AXApplication"]) break;
      if(scrolling?cuScrollBar(el,[operation isEqual:@"scroll-horizontal"])!=nil:cuClickAction(el,[operation isEqual:@"context"])!=nil) { chosen=cur; break; }
      cur=attr(el,@"AXParent");
    }
    // 2. Otherwise search downward for the smallest control covering the point.
    if(!chosen) {
      int budget=1500; double area=0; id best=nil;
      if(hit) cuSearch((__bridge AXUIElementRef)hit,p,0,&budget,&best,&area,operation);
      else for(id w in attr(appEl,@"AXWindows")) {
        CGRect frame;
        if(!cuFrame((__bridge AXUIElementRef)w,&frame) || !CGRectContainsPoint(frame,p)) continue;
        if(pinned) {
          uint32_t matched = 0;
          if(!CGRectEqualToRect(frame,observedFrame) || !cuWindowNumberForFrame(inputApp.processIdentifier,frame,&matched) || matched != observedNumber) continue;
        }
        // A sheet owns the window's interaction, even when the sheet does not cover p.
        NSArray *sheets=attr((__bridge AXUIElementRef)w,@"AXSheets");
        if(sheets.count) {
          for(id sheet in sheets) cuSearch((__bridge AXUIElementRef)sheet,p,0,&budget,&best,&area,operation);
          insideSheet=YES;
        } else cuSearch((__bridge AXUIElementRef)w,p,0,&budget,&best,&area,operation);
        break; // Never click through another window of the same app.
      }
      chosen=best;
    }
    CFRelease(appEl);
    if(!chosen) {
      // A web popup button reports unpressable on purpose (its menu only opens
      // from a real mouse event); name it so the caller can poll for the menu
      // through Chromium's post-activation AX rebuild.
      if(hit) {
        for(id cur=hit; cur;) {
          AXUIElementRef el=(__bridge AXUIElementRef)cur;
          id role=attr(el,@"AXRole");
          if([role isEqual:@"AXWindow"] || [role isEqual:@"AXApplication"]) break;
          if([@[@"AXMenuButton",@"AXPopUpButton"] containsObject:role] && axHasWebAncestor(el))
            return @{@"found":@NO,@"reason":@"web_popup_requires_real_click"};
          cur=attr(el,@"AXParent");
        }
      }
      return @{@"found":@NO,@"reason":hit?@"no_pressable_element_at_point":@"no_element_at_point"};
    }

    // A press invokes the control's action directly, which would sail straight
    // past a window-modal sheet that a real click cannot cross. Refuse instead:
    // the caller must deal with the sheet.
    if(!insideSheet) {
      id owner=chosen;
      for(int up=0; up<12 && owner; up++) {
        AXUIElementRef el=(__bridge AXUIElementRef)owner;
        id role=attr(el,@"AXRole");
        if([role isEqual:@"AXSheet"]) { insideSheet=YES; break; }
        if([role isEqual:@"AXWindow"]) {
          for(id kid in attr(el,@"AXChildren")) {
            if([attr((__bridge AXUIElementRef)kid,@"AXRole") isEqual:@"AXSheet"])
              return @{@"found":@NO,@"reason":@"window_blocked_by_modal_sheet"};
          }
          break;
        }
        owner=attr(el,@"AXParent");
      }
    }

    NSDictionary *element=info((__bridge AXUIElementRef)chosen,0,0,@[]);
    if(![args[@"perform"] boolValue]) return @{@"found":@YES,@"element":element,@"action_sent":@NO};
    cuCheckCancelled();
    NSMutableDictionary *receipt=[(scrolling?cuScroll((__bridge AXUIElementRef)chosen,args):cuClick((__bridge AXUIElementRef)chosen,[operation isEqual:@"context"],args)) mutableCopy];
    receipt[@"found"]=@YES; receipt[@"element"]=element; return receipt;
  }
  /**
   * Pointer gestures are window-routed event records addressed to a window of
   * the bound app (cuBgPointer). The cursor the user holds is never moved.
   */
  if([tool isEqual:@"pointer_context"]) return cuPointerContext(inputApp,args,nil);
  if([tool isEqual:@"bg_pointer"]) return cuBgPointer(inputApp, args);
  if([tool isEqual:@"scroll"]) {
    cuCheckCancelled();
    CGEventRef event=CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitLine,2,[args[@"dy"] intValue],[args[@"dx"] intValue]); CGEventPostToPid(inputApp.processIdentifier,event); CFRelease(event); return @{@"action_sent":@YES};
  }
  if([tool isEqual:@"cursor_position"]) {
    CGEventRef event=CGEventCreate(NULL); CGPoint p=CGEventGetLocation(event); CFRelease(event); return @{@"x":@(p.x),@"y":@(p.y)};
  }
  NSRunningApplication *a=resolve(args[@"app_ref"]?:args[@"target"][@"app_ref"]);
  if(!a) @throw [NSException exceptionWithName:@"app" reason:@"application not found" userInfo:nil];
  if(mutates && [a.bundleIdentifier isEqual:@"net.codewhale.computer-use"]) @throw [NSException exceptionWithName:@"protected" reason:@"Computer Use safety controls belong to the user." userInfo:nil];
  AXUIElementRef app=AXUIElementCreateApplication(a.processIdentifier);
  AXUIElementSetMessagingTimeout(app,2.0);
  axPrepare(app);
  @try {
    if([tool isEqual:@"invoke_menu"]) return cuInvokeMenu(app,a.processIdentifier,args);
    NSArray *ws=attr(app,@"AXWindows")?:@[];
    NSDictionary *identity=@{@"found":@YES,@"name":a.localizedName?:@"",@"pid":@(a.processIdentifier),@"bundle_id":a.bundleIdentifier?:@"",@"frontmost":@(a.active)};
    if([tool isEqual:@"get_app_state"] || [tool isEqual:@"list_windows"]) {
      BOOL truncated=NO;
      BOOL list=[tool isEqual:@"list_windows"];
      NSArray *out=observeElements(app,ws,args,list,&truncated);
      // A window that vends no descendants at all is not a page — it is an app
      // whose content tree is mid-rebuild (Chromium tears down and rebuilds
      // its accessibility tree across activation transitions, which takes
      // seconds). Poll briefly rather than returning an empty UI. A filtered
      // observe (query/role) legitimately matches nothing, so only unfiltered
      // observes earn the wait.
      // While a menu lease is held for this app, the thing being waited on is
      // the open menu's items: they reappear only when Chromium's rebuilt
      // tree re-vends them, so poll until an in-window AXMenuItem exists.
      BOOL leaseHeld = cuFrontLeaseHeldForPid(a.processIdentifier);
      int maxAttempts = leaseHeld ? 20 : 8;
      for(int attempt=0; !list && attempt<maxAttempts; attempt++) {
        BOOL empty = hasOrphanWebArea(out);
        if(!ws.count) {
          NSArray *visible=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly,kCGNullWindowID));
          for(NSDictionary *w in visible) if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue]==a.processIdentifier && [w[(__bridge NSString *)kCGWindowLayer] intValue]==0) { empty=YES; break; }
        }
        if(!empty && !args[@"query"] && !args[@"role"]) {
          if(leaseHeld) {
            empty = YES;
            for(NSDictionary *d in out) {
              if([d[@"role"] isEqual:@"AXMenuItem"] && [d[@"windowIndex"] integerValue] >= 0) { empty = NO; break; }
            }
          } else if(ws.count) {
            BOOL anyContent = NO;
            for(NSDictionary *d in out) {
              if([d[@"windowIndex"] integerValue] >= 0 && [d[@"path"] count] > 0) { anyContent = YES; break; }
            }
            empty = !anyContent;
          }
        }
        if(!empty) break;
        usleep(300000);
        ws=attr(app,@"AXWindows")?:ws;
        truncated=NO;
        out=observeElements(app,ws,args,list,&truncated);
      }
      NSMutableDictionary *d=[identity mutableCopy]; d[list?@"windows":@"elements"]=out; d[@"truncated"]=@(truncated); return d;
    }
    if([tool isEqual:@"resolve_element"]) {
      NSInteger wi=[args[@"windowIndex"] integerValue];
      id el=wi==-1?attr(app,@"AXMenuBar"):wi==-2?(__bridge id)app:(wi>=0 && wi<ws.count?ws[wi]:nil);
      if(!el) return @{@"found":@NO,@"element":[NSNull null],@"reason":@"window_not_found"};
      for(NSNumber *i in args[@"path"]?:@[]) { NSArray *kids=attr((__bridge AXUIElementRef)el,@"AXChildren"); if(i.unsignedIntegerValue>=kids.count) return @{@"found":@NO,@"element":[NSNull null],@"reason":@"path_not_found"}; el=kids[i.unsignedIntegerValue]; }
      if(args[@"native_ref"]) cuValidateElementIdentity((__bridge AXUIElementRef)el,args);
      return @{@"found":@YES,@"element":info((__bridge AXUIElementRef)el,0,wi,args[@"path"]?:@[]),@"reason":[NSNull null]};
    }
    NSDictionary *t=args[@"target"]; NSInteger wi=[t[@"windowIndex"] integerValue];
    id el=wi==-1?attr(app,@"AXMenuBar"):wi==-2?(__bridge id)app:(wi>=0 && wi<ws.count?ws[wi]:nil);
    if(!el) @throw [NSException exceptionWithName:@"stale" reason:@"window is no longer available; observe again" userInfo:nil];
    for(NSNumber *i in t[@"path"]) { NSArray *kids=attr((__bridge AXUIElementRef)el,@"AXChildren"); if(i.unsignedIntegerValue>=kids.count) @throw [NSException exceptionWithName:@"stale" reason:@"element is no longer available; observe again" userInfo:nil]; el=kids[i.unsignedIntegerValue]; }
    if(wi>=0) {
      NSArray *sheets=attr((__bridge AXUIElementRef)ws[wi],@"AXSheets");
      if(sheets.count) {
        BOOL inside=NO; id ancestor=el;
        for(int depth=0;ancestor && depth<64;depth++) {
          for(id sheet in sheets) if(CFEqual((__bridge CFTypeRef)ancestor,(__bridge CFTypeRef)sheet)) inside=YES;
          if(inside) break;
          ancestor=attr((__bridge AXUIElementRef)ancestor,@"AXParent");
        }
        if(!inside) @throw [NSException exceptionWithName:@"modal" reason:@"window blocked by modal sheet; observe and handle the dialog first" userInfo:nil];
      }
    }
    cuCheckCancelled();
    if([t[@"type"] isEqual:@"element"]) cuValidateElementIdentity((__bridge AXUIElementRef)el,t);
    if([tool isEqual:@"click_element"]) return cuClick((__bridge AXUIElementRef)el,[args[@"context"] boolValue],args);
    if([tool isEqual:@"scroll_element"]) return cuScroll((__bridge AXUIElementRef)el,args);
    AXError e=kAXErrorFailure;
    if([tool isEqual:@"get_value"]) {
      id v=attr((__bridge AXUIElementRef)el,@"AXValue");
      return @{@"ok":@YES,@"strategy":@"a11y",@"value":v?:[NSNull null],@"role":attr((__bridge AXUIElementRef)el,@"AXRole")?:[NSNull null]};
    }
    if([tool isEqual:@"set_value"]) {
      NSString *role=attr((__bridge AXUIElementRef)el,@"AXRole");
      if(axHasWebAncestor((__bridge AXUIElementRef)el)) return cuReplaceWebText(args,a,el);
      BOOL numeric=[@[@"AXIncrementor",@"AXSlider",@"AXStepper",@"AXValueIndicator",@"AXProgressIndicator"] containsObject:role];
      id value=args[@"value"];
      if(numeric) {
        // These controls type AXValue as a number. Writing a string is the
        // classic "clears the field instead of setting it" bug — a web
        // incrementor may coerce "" over "150" and report success.
        if(![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID()) {
          NSString *s=[value isKindOfClass:NSString.class]?value:[value description];
          static NSNumberFormatter *fmt=nil;
          if(!fmt) { fmt=[NSNumberFormatter new]; fmt.locale=[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]; fmt.numberStyle=NSNumberFormatterDecimalStyle; }
          NSNumber *n=[fmt numberFromString:s];
          if(!n) @throw [NSException exceptionWithName:@"value" reason:[NSString stringWithFormat:@"%@ takes a numeric AXValue; %@ does not parse — focus the control and type instead",role?:@"this control",s] userInfo:nil];
          value=n;
        }
      }
      if([role isEqual:@"AXTextArea"] && [value isKindOfClass:NSString.class] && cuSettable((__bridge AXUIElementRef)el,@"AXSelectedText") && cuSettable((__bridge AXUIElementRef)el,@"AXSelectedTextRange")) {
        id before=attr((__bridge AXUIElementRef)el,@"AXValue");
        if(![before isKindOfClass:NSString.class]) @throw [NSException exceptionWithName:@"value" reason:@"the text area's current value is unavailable; observe before replacing it" userInfo:nil];
        AXValueRef range=AXValueCreate(kAXValueCFRangeType,&(CFRange){0,[before length]});
        e=AXUIElementSetAttributeValue((__bridge AXUIElementRef)el,kAXSelectedTextRangeAttribute,range);
        CFRelease(range);
        if(e==kAXErrorSuccess) {
          cuCheckCancelled();
          cuValidateElementIdentity((__bridge AXUIElementRef)el,t);
          e=AXUIElementSetAttributeValue((__bridge AXUIElementRef)el,kAXSelectedTextAttribute,(__bridge CFStringRef)value);
        }
      } else e=AXUIElementSetAttributeValue((__bridge AXUIElementRef)el,kAXValueAttribute,(__bridge CFTypeRef)value);
      if(e==kAXErrorSuccess) {
        usleep(60000);
        id after=attr((__bridge AXUIElementRef)el,@"AXValue");
        BOOL verified=NO;
        if(numeric) verified=[after isKindOfClass:NSNumber.class] && fabs([after doubleValue]-[value doubleValue])<1e-6;
        else verified=[after isKindOfClass:NSString.class] && [after isEqual:value];
        NSMutableDictionary *done=[@{@"action_sent":@YES,@"strategy":@"a11y",@"role":role?:[NSNull null],@"after":after?:[NSNull null],@"verified":@(verified),@"verification_scope":@"control-value"} mutableCopy];
        if(!verified) done[@"note"]=@"AXValue write did not verify: the control kept its own value (Electron/web text elements and numeric steppers commonly ignore background AXValue writes). Focus the element and use type instead, then verify with get_value.";
        return done;
      }
    }
    else if([tool isEqual:@"focus_element"]) e=AXUIElementSetAttributeValue((__bridge AXUIElementRef)el,kAXFocusedAttribute,kCFBooleanTrue);
    else if([tool isEqual:@"select_text"]){ NSArray *r=args[@"text_range"]?:@[@0,@0]; if(r.count!=2 || [r[0] longValue]<0 || [r[1] longValue]<0) @throw [NSException exceptionWithName:@"range" reason:@"text_range must be [start, length], both nonnegative" userInfo:nil]; CFRange range=CFRangeMake([r[0] longValue],[r[1] longValue]); AXValueRef v=AXValueCreate(kAXValueCFRangeType,&range); e=AXUIElementSetAttributeValue((__bridge AXUIElementRef)el,kAXSelectedTextRangeAttribute,v); CFRelease(v); }
    else if([tool isEqual:@"perform_action"]){ CFArrayRef actions=NULL; AXUIElementCopyActionNames((__bridge AXUIElementRef)el,&actions); NSArray *names=CFBridgingRelease(actions); if(![names containsObject:args[@"action"]]) @throw [NSException exceptionWithName:@"action" reason:@"action is not advertised by this element" userInfo:nil]; cuCheckCancelled(); e=AXUIElementPerformAction((__bridge AXUIElementRef)el,(__bridge CFStringRef)args[@"action"]); }
    if(e!=kAXErrorSuccess) @throw [NSException exceptionWithName:@"action" reason:[NSString stringWithFormat:@"accessibility action failed: %d",e] userInfo:nil];
    NSMutableDictionary *done=[@{@"action_sent":@YES,@"strategy":@"a11y"} mutableCopy];
    if([tool isEqual:@"focus_element"]) done[@"focused"]=@YES;
    return done;
  } @finally { CFRelease(app); }
}
typedef OSStatus (*cuKeyFocusFn)(ProcessSerialNumber *, uint32_t *);
typedef OSStatus (*cuPsnPidFn)(const ProcessSerialNumber *, pid_t *);
typedef CGError (*cuStealFocusFn)(uint32_t, uint32_t, int32_t *);
typedef CGError (*cuReleaseFocusFn)(int32_t);
typedef uint32_t (*cuMainConnFn)(void);
typedef int (*cuPMCreateFn)(CFStringRef, uint32_t, CFStringRef, uint32_t *);
typedef int (*cuPMReleaseFn)(uint32_t);
static cuKeyFocusFn cuKeyFocus;
static cuPsnPidFn cuPsnPid;
static cuStealFocusFn cuStealFocus;
static cuReleaseFocusFn cuReleaseFocus;
static cuMainConnFn cuMainConn;
static cuPMCreateFn cuPMCreate;
static cuPMReleaseFn cuPMRelease;
static NSObject *cuAgentLock;
static dispatch_queue_t cuAgentQ, cuAgentWriteQ;
static NSMutableDictionary<NSNumber *, NSMutableDictionary *> *cuGuards;
static NSMutableDictionary<NSString *, NSMutableDictionary *> *cuAgentActions;
static NSMutableDictionary<NSNumber *, NSValue *> *cuTargetTaps;
static NSMutableDictionary<NSNumber *, NSMutableDictionary *> *cuWatches;
static CFMachPortRef cuFrontTap;
static pid_t cuFrontTapPid;
static double cuLookupUntil;
static uint64_t cuEpoch, cuTailGen;
static uint64_t cuReleased, cuMissed, cuReverted, cuRestored;
static NSDictionary *cuLate;
static uint32_t cuAwakeId;
static double cuAwakeUntil;
static double cuNow(void) { return NSProcessInfo.processInfo.systemUptime; }
static BOOL cuAgentResolve(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cuResolveBgPointer();
    void *sl = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
    void *hs = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_LAZY);
    void *io = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
    if(sl) {
      cuKeyFocus = (cuKeyFocusFn)dlsym(sl, "SLPSGetKeyFocusProcess");
      cuStealFocus = (cuStealFocusFn)dlsym(sl, "SLPSStealKeyFocusReturningID");
      cuReleaseFocus = (cuReleaseFocusFn)dlsym(sl, "SLPSReleaseKeyFocusWithID");
      cuMainConn = (cuMainConnFn)dlsym(sl, "SLSMainConnectionID");
    }
    if(hs) cuPsnPid = (cuPsnPidFn)dlsym(hs, "GetProcessPID");
    if(io) { cuPMCreate = (cuPMCreateFn)dlsym(io, "IOPMAssertionCreateWithName"); cuPMRelease = (cuPMReleaseFn)dlsym(io, "IOPMAssertionRelease"); }
  });
  return cuResolveBgPointer() && cuPsnPid;
}
static BOOL cuScreenLocked(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  return [session[@"CGSSessionScreenIsLocked"] boolValue];
}
static pid_t cuPidOfPSN(ProcessSerialNumber *psn) {
  pid_t pid = 0;
  if(!cuPsnPid || (psn->highLongOfPSN == 0 && psn->lowLongOfPSN == 0) || cuPsnPid(psn, &pid) != 0) return 0;
  return pid;
}
static pid_t cuAgentFrontPid(void) {
  ProcessSerialNumber psn = {0, 0};
  if(!cuAgentResolve() || cuGetFront(&psn) != 0) return 0;
  return cuPidOfPSN(&psn);
}
static pid_t cuAgentKeyFocusPid(void) {
  ProcessSerialNumber psn = {0, 0};
  uint32_t second[4] = {0};
  if(!cuAgentResolve() || !cuKeyFocus || cuKeyFocus(&psn, second) != 0) return 0;
  return cuPidOfPSN(&psn);
}
static NSArray<NSDictionary *> *cuAgentWindows(void) {
  NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  NSMutableArray *out = [NSMutableArray array];
  pid_t own = getpid();
  for(NSDictionary *w in list) {
    int layer = [w[(__bridge NSString *)kCGWindowLayer] intValue];
    pid_t pid = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    if(pid == own || !((layer >= 0 && layer <= 20) || layer == kCGPopUpMenuWindowLevel)) continue;
    CGRect b = CGRectZero;
    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &b);
    if(b.size.width < 2 || b.size.height < 2) continue;
    [out addObject:@{ @"window_id": w[(__bridge NSString *)kCGWindowNumber] ?: @0, @"pid": @(pid), @"layer": @(layer),
                      @"app": w[(__bridge NSString *)kCGWindowOwnerName] ?: @"", @"title": w[(__bridge NSString *)kCGWindowName] ?: @"",
                      @"bounds": @{ @"x": @(b.origin.x), @"y": @(b.origin.y), @"w": @(b.size.width), @"h": @(b.size.height) } }];
  }
  return out;
}
static uint32_t cuFrontWindowOfPid(pid_t pid, NSArray *windows) {
  for(NSDictionary *w in windows ?: cuAgentWindows()) if([w[@"pid"] intValue] == pid && [w[@"layer"] intValue] == 0) return [w[@"window_id"] unsignedIntValue];
  return 0;
}
static BOOL cuTargetAboveFront(pid_t target, pid_t front) {
  if(target <= 0 || front <= 0 || target == front) return NO;
  BOOL targetFirst = NO;
  for(NSDictionary *w in cuAgentWindows()) {
    if([w[@"layer"] intValue] != 0) continue;
    pid_t pid = [w[@"pid"] intValue];
    if(pid == front) return targetFirst;
    if(pid == target) targetFirst = YES;
  }
  return NO;
}
static BOOL cuUserSwitchedRecently(void) {
  CGEventType kinds[] = { kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown };
  for(int i = 0; i < 3; i++) {
    double since = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kinds[i]);
    if(isfinite(since) && since >= 0 && since < 1.0) return YES;
  }
  return (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl)) != 0;
}
static BOOL cuRestoreFrontIfRaised(pid_t target, pid_t front) {
  if(cuAgentFrontPid() != front || !cuTargetAboveFront(target, front)) return NO;
  AXUIElementRef app = AXUIElementCreateApplication(front);
  AXUIElementSetMessagingTimeout(app, 0.5);
  id window = attr(app, @"AXFocusedWindow");
  AXError e = window ? AXUIElementPerformAction((__bridge AXUIElementRef)window, kAXRaiseAction) : kAXErrorFailure;
  CFRelease(app);
  if(e != kAXErrorSuccess)
    [[NSRunningApplication runningApplicationWithProcessIdentifier:front] activateWithOptions:NSApplicationActivateAllWindows];
  @synchronized(cuAgentLock) { cuRestored++; }
  return YES;
}
static BOOL cuRevertActivation(pid_t target, pid_t front) {
  if(target <= 0) return NO;
  pid_t now = cuAgentFrontPid();
  if(!now || !front || now == front || now != target || now == getpid() || now == getppid()) return NO;
  if(cuUserSwitchedRecently()) return NO;
  BOOL restored = NO;
  uint32_t wid = cuFrontWindowOfPid(front, nil);
  ProcessSerialNumber psn;
  if(wid && cuGetPSN(front, &psn) == 0 && cuSetFront(&psn, wid, 0x200) == 0) {
    cuPostWindowRecord(&psn, wid, 0x01);
    cuPostWindowRecord(&psn, wid, 0x02);
    restored = cuAgentFrontPid() == front;
  }
  if(!restored) [[NSRunningApplication runningApplicationWithProcessIdentifier:front] activateWithOptions:0];
  @synchronized(cuAgentLock) { cuReverted++; }
  return YES;
}
static BOOL cuGuardLive(NSDictionary *g, double now) {
  return ([g[@"leases"] intValue] > 0 && now - [g[@"armed_at"] doubleValue] < 30.0) || now < [g[@"until"] doubleValue];
}
static BOOL cuIsGuarded(pid_t pid) {
  @synchronized(cuAgentLock) {
    NSMutableDictionary *g = cuGuards[@(pid)];
    if(!g || [g[@"epoch"] unsignedLongLongValue] != cuEpoch) return NO;
    return cuGuardLive(g, cuNow());
  }
}
static BOOL cuReleaseTargetTheft(void) {
  if(!cuStealFocus || !cuReleaseFocus || !cuMainConn) return NO;
  @synchronized(cuAgentLock) { cuLookupUntil = cuNow() + 0.5; }
  int32_t own = 0;
  if(cuStealFocus(cuMainConn(), 0xC80, &own) != 0 || own == 0) return NO;
  cuReleaseFocus(own);
  for(int back = 1; back <= 4; back++) {
    int32_t theft = own - back;
    if(theft != 0 && cuReleaseFocus(theft) == 0) return YES;
  }
  return NO;
}
static void cuWaitMenuWindow(pid_t pid, double budget) {
  double deadline = cuNow() + budget;
  while(cuNow() < deadline) {
    NSArray *list = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
    for(NSDictionary *w in list)
      if([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid && [w[(__bridge NSString *)kCGWindowLayer] intValue] >= kCGPopUpMenuWindowLevel) return;
    usleep(1000);
  }
}
static CGEventRef cuFrontTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) { @autoreleasepool {
  if(type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { if(cuFrontTap) CGEventTapEnable(cuFrontTap, true); return event; }
  if(type != 21 || !event || CGEventGetIntegerValueField(event, 64) != 0x4000) return event;
  int64_t thief = CGEventGetIntegerValueField(event, 73);
  if(thief == getpid()) return NULL;
  if(thief <= 0 || thief > INT32_MAX || !cuIsGuarded((pid_t)thief) || cuAgentFrontPid() == (pid_t)thief) return event;
  pid_t target = (pid_t)thief, front = cuFrontTapPid;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
    cuWaitMenuWindow(target, 0.15);
    cuRestoreFrontIfRaised(target, front);
    BOOL released = cuReleaseTargetTheft();
    @synchronized(cuAgentLock) { if(released) cuReleased++; else cuMissed++; }
  });
  return NULL;
} }
static CGEventRef cuTargetTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) { @autoreleasepool {
  if(type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    @synchronized(cuAgentLock) { for(NSValue *v in cuTargetTaps.allValues) CGEventTapEnable((CFMachPortRef)v.pointerValue, true); }
    return event;
  }
  if(type != 21 || !event || CGEventGetIntegerValueField(event, 64) != 0x4000) return event;
  BOOL inLookup;
  @synchronized(cuAgentLock) { inLookup = cuNow() < cuLookupUntil; }
  return inLookup && CGEventGetIntegerValueField(event, 73) == getpid() ? NULL : event;
} }
static CFMachPortRef cuInstallTap(pid_t pid, CGEventTapCallBack callback) {
  CFMachPortRef port = CGEventTapCreateForPid(pid, kCGHeadInsertEventTap, kCGEventTapOptionDefault, 1ULL << 21, callback, NULL);
  if(!port) return NULL;
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, port, 0);
  if(!source) { CFMachPortInvalidate(port); CFRelease(port); return NULL; }
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
  CFRelease(source);
  CGEventTapEnable(port, true);
  return port;
}
static void cuRemoveTap(CFMachPortRef port) {
  if(!port) return;
  CGEventTapEnable(port, false);
  CFMachPortInvalidate(port);
  CFRelease(port);
}
static BOOL cuEnsureTaps(pid_t front, pid_t target) {
  if(cuFrontTapPid != front || !cuFrontTap) {
    cuRemoveTap(cuFrontTap);
    cuFrontTap = cuInstallTap(front, cuFrontTapCallback);
    cuFrontTapPid = cuFrontTap ? front : 0;
  }
  if(!cuFrontTap) return NO;
  BOOL have;
  @synchronized(cuAgentLock) { have = cuTargetTaps[@(target)] != nil; }
  if(!have) {
    CFMachPortRef port = cuInstallTap(target, cuTargetTapCallback);
    if(port) @synchronized(cuAgentLock) { cuTargetTaps[@(target)] = [NSValue valueWithPointer:port]; }
  }
  return YES;
}
static void cuScheduleTapTeardown(double delay) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSMutableArray *idle = [NSMutableArray array];
    BOOL none;
    @synchronized(cuAgentLock) {
      double now = cuNow();
      for(NSNumber *pid in cuGuards.allKeys)
        if(!cuGuardLive(cuGuards[pid], now)) [cuGuards removeObjectForKey:pid];
      for(NSString *aid in cuAgentActions.allKeys)
        if(now - [cuAgentActions[aid][@"at"] doubleValue] > 60.0) [cuAgentActions removeObjectForKey:aid];
      for(NSNumber *pid in cuTargetTaps.allKeys) if(!cuGuards[pid]) { [idle addObject:cuTargetTaps[pid]]; [cuTargetTaps removeObjectForKey:pid]; }
      none = cuGuards.count == 0;
    }
    for(NSValue *v in idle) cuRemoveTap((CFMachPortRef)v.pointerValue);
    if(none) { cuRemoveTap(cuFrontTap); cuFrontTap = NULL; cuFrontTapPid = 0; }
  });
}
static void cuNoteActivity(double awake) {
  if(awake <= 0 || !cuPMCreate) return;
  @synchronized(cuAgentLock) {
    cuAwakeUntil = cuNow() + awake;
    if(!cuAwakeId) cuPMCreate(CFSTR("PreventUserIdleDisplaySleep"), 255, CFSTR("Codewhale Computer Use is working"), &cuAwakeId);
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((awake + 1) * NSEC_PER_SEC)), cuAgentQ, ^{
    @synchronized(cuAgentLock) {
      if(cuAwakeId && cuNow() >= cuAwakeUntil) { cuPMRelease(cuAwakeId); cuAwakeId = 0; }
    }
  });
}
static NSArray *cuNewWindows(NSSet *before, NSArray *now) {
  NSMutableArray *out = [NSMutableArray array];
  for(NSDictionary *w in now) if(![before containsObject:w[@"window_id"]]) [out addObject:w];
  return out;
}
static NSDictionary *cuAgentArm(NSDictionary *req) {
  if(!cuAgentResolve()) return @{ @"ok": @NO, @"error": @"agent_unavailable" };
  pid_t target = [req[@"target_pid"] intValue];
  pid_t front = cuAgentFrontPid(), holder = cuAgentKeyFocusPid() ?: front;
  NSArray *windows = cuAgentWindows();
  NSMutableSet *ids = [NSMutableSet set];
  for(NSDictionary *w in windows) [ids addObject:w[@"window_id"]];
  NSString *aid = NSUUID.UUID.UUIDString;
  BOOL guarded = NO;
  uint64_t epoch;
  NSArray *earlier;
  @synchronized(cuAgentLock) {
    epoch = cuEpoch;
    earlier = cuLate && cuNow() - [cuLate[@"at"] doubleValue] < 10 ? cuLate[@"new_windows"] : @[];
    cuLate = nil;
    cuTailGen++;
    if(target > 0) {
      NSMutableDictionary *g = cuGuards[@(target)] ?: [@{ @"leases": @0 } mutableCopy];
      g[@"leases"] = @([g[@"leases"] intValue] + 1);
      g[@"until"] = @(cuNow() + 3.0);
      g[@"armed_at"] = @(cuNow());
      g[@"epoch"] = @(epoch);
      cuGuards[@(target)] = g;
    }
  }
  if(target > 0 && front > 0 && holder == front && front != target && front != getpid() && cuStealFocus && cuReleaseFocus && cuMainConn)
    guarded = cuEnsureTaps(front, target);
  BOOL above = cuTargetAboveFront(target, front);
  @synchronized(cuAgentLock) {
    cuAgentActions[aid] = [@{ @"at": @(cuNow()), @"target": @(target), @"front": @(front), @"ids": ids, @"epoch": @(epoch), @"above": @(above), @"earlier": earlier ?: @[],
                         @"released": @(cuReleased), @"missed": @(cuMissed), @"reverted": @(cuReverted), @"restored": @(cuRestored) } mutableCopy];
  }
  cuNoteActivity([req[@"awake_s"] doubleValue]);
  cuScheduleTapTeardown(31.0);
  return @{ @"ok": @YES, @"action": aid, @"front_pid": @(front), @"key_focus_pid": @(holder), @"key_focus_guard": @(guarded), @"screen_locked": @(cuScreenLocked()) };
}
static void cuWatchTick(NSNumber *key) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), cuAgentQ, ^{ @autoreleasepool {
    NSMutableDictionary *w;
    uint64_t epoch, tailNow;
    @synchronized(cuAgentLock) { w = cuWatches[key]; epoch = cuEpoch; tailNow = cuTailGen; }
    if(!w) return;
    pid_t target = key.intValue, front = [w[@"front"] intValue];
    BOOL live = [w[@"epoch"] unsignedLongLongValue] == epoch;
    if(live && [w[@"reverts"] intValue] < 3 && cuRevertActivation(target, front)) w[@"reverts"] = @([w[@"reverts"] intValue] + 1);
    if(live && [w[@"order"] boolValue] && [w[@"restores"] intValue] < 3 && cuRestoreFrontIfRaised(target, front)) w[@"restores"] = @([w[@"restores"] intValue] + 1);
    if([w[@"tail"] unsignedLongLongValue] == tailNow && cuNow() < [w[@"late_until"] doubleValue]) {
      NSArray *fresh = cuNewWindows(w[@"ids"], cuAgentWindows());
      if(fresh.count > [w[@"seen"] count]) {
        w[@"seen"] = fresh;
        @synchronized(cuAgentLock) { if(cuTailGen == [w[@"tail"] unsignedLongLongValue]) cuLate = @{ @"at": @(cuNow()), @"new_windows": fresh }; }
      }
    }
    BOOL more = live && cuNow() < [w[@"until"] doubleValue];
    @synchronized(cuAgentLock) { if(!more && cuWatches[key] == w) [cuWatches removeObjectForKey:key]; }
    if(more) cuWatchTick(key);
  } });
}
static void cuWatchStart(pid_t target, pid_t front, NSSet *ids, uint64_t epoch, uint64_t tail, BOOL order, NSArray *seen) {
  NSNumber *key = @(target);
  BOOL running;
  @synchronized(cuAgentLock) {
    NSMutableDictionary *w = cuWatches[key];
    running = w != nil && [w[@"epoch"] unsignedLongLongValue] == epoch;
    if(!running) { w = [@{ @"reverts": @0, @"restores": @0 } mutableCopy]; cuWatches[key] = w; }
    [w addEntriesFromDictionary:@{ @"front": @(front), @"ids": ids, @"epoch": @(epoch), @"tail": @(tail), @"order": @(order), @"seen": seen,
                                   @"until": @(cuNow() + 2.5), @"late_until": @(cuNow() + 1.0) }];
  }
  if(!running) cuWatchTick(key);
}
static void cuAgentSettle(NSDictionary *req, void (^reply)(NSDictionary *)) {
  NSString *aid = req[@"action"];
  NSMutableDictionary *a;
  @synchronized(cuAgentLock) { a = cuAgentActions[aid]; if(a) [cuAgentActions removeObjectForKey:aid]; }
  if(!a) { reply(@{ @"ok": @NO, @"error": @"unknown_action" }); return; }
  double report = req[@"report_ms"] ? [req[@"report_ms"] doubleValue] / 1000.0 : 0.3;
  dispatch_async(cuAgentQ, ^{ @autoreleasepool {
    pid_t target = req[@"target_pid"] ? [req[@"target_pid"] intValue] : [a[@"target"] intValue], front = [a[@"front"] intValue];
    NSSet *ids = a[@"ids"];
    uint64_t epoch = [a[@"epoch"] unsignedLongLongValue];
    BOOL order = ![a[@"above"] boolValue];
    double deadline = cuNow() + report;
    NSArray *fresh = @[];
    pid_t nowFront = front;
    BOOL reverted = NO, restored = NO;
    do {
      if(report > 0) usleep(25000);
      uint64_t current;
      @synchronized(cuAgentLock) { current = cuEpoch; }
      if(current == epoch) {
        if(!reverted) reverted = cuRevertActivation(target, front);
        if(order && !restored) restored = cuRestoreFrontIfRaised(target, front);
      }
      fresh = cuNewWindows(ids, cuAgentWindows());
      nowFront = cuAgentFrontPid();
      if(fresh.count) break;
    } while(cuNow() < deadline);
    pid_t keyNow = cuAgentKeyFocusPid();
    NSDictionary *result;
    @synchronized(cuAgentLock) {
      pid_t leased = [a[@"target"] intValue];
      if(leased > 0) {
        NSMutableDictionary *g = cuGuards[@(leased)];
        if(g) { g[@"leases"] = @(MAX(0, [g[@"leases"] intValue] - 1)); g[@"until"] = @(cuNow() + 3.0); }
      }
      result = @{ @"ok": @YES, @"new_windows": fresh, @"front_pid_before": @(front), @"front_pid_after": @(nowFront),
                  @"foreground_changed": @(front && nowFront && front != nowFront),
                  @"key_focus_released": @(cuReleased - [a[@"released"] unsignedLongLongValue]),
                  @"key_focus_missed": @(cuMissed - [a[@"missed"] unsignedLongLongValue]),
                  @"self_activation_reverted": @(cuReverted - [a[@"reverted"] unsignedLongLongValue]),
                  @"window_order_restored": @(cuRestored - [a[@"restored"] unsignedLongLongValue]),
                  @"key_focus_pid": @(keyNow),
                  @"earlier_new_windows": a[@"earlier"] ?: @[] };
    }
    reply(result);
    uint64_t tail;
    @synchronized(cuAgentLock) { tail = cuTailGen; }
    cuWatchStart(target, front, ids, epoch, tail, order, fresh);
    cuScheduleTapTeardown(4.0);
  } });
}
static void cuAgentWaitWindow(NSDictionary *req, void (^reply)(NSDictionary *)) {
  pid_t pid = [req[@"pid"] intValue];
  double deadline = cuNow() + MIN(30.0, MAX(0.1, [req[@"timeout_ms"] doubleValue] / 1000.0));
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    while(YES) { @autoreleasepool {
      for(NSDictionary *w in cuAgentWindows())
        if([w[@"pid"] intValue] == pid) { reply(@{ @"ok": @YES, @"window": w, @"front_pid": @(cuAgentFrontPid()) }); return; }
      if(cuNow() >= deadline) { reply(@{ @"ok": @YES, @"window": NSNull.null, @"front_pid": @(cuAgentFrontPid()) }); return; }
      usleep(50000);
    } }
  });
}
typedef CFArrayRef (*cuCopySpacesFn)(uint32_t, int, CFArrayRef);
typedef CFStringRef (*cuCopyDisplayForWindowFn)(uint32_t, uint32_t);
typedef uint64_t (*cuDisplaySpaceFn)(uint32_t, CFStringRef);
typedef CFArrayRef (*cuHWCaptureFn)(uint32_t, uint32_t *, int, uint32_t);
static cuCopySpacesFn cuCopySpaces;
static cuCopyDisplayForWindowFn cuCopyDisplayForWindow;
static cuDisplaySpaceFn cuDisplaySpace;
static cuHWCaptureFn cuHWCapture;
static void cuResolveCapture(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    void *sl = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
    if(!sl) return;
    cuCopySpaces = (cuCopySpacesFn)dlsym(sl, "SLSCopySpacesForWindows");
    cuCopyDisplayForWindow = (cuCopyDisplayForWindowFn)dlsym(sl, "SLSCopyManagedDisplayForWindow");
    cuDisplaySpace = (cuDisplaySpaceFn)dlsym(sl, "SLSManagedDisplayGetCurrentSpace");
    cuHWCapture = (cuHWCaptureFn)dlsym(sl, "SLSHWCaptureWindowList");
    if(!cuMainConn) cuMainConn = (cuMainConnFn)dlsym(sl, "SLSMainConnectionID");
  });
}
static NSNumber *cuWindowOnCurrentSpace(uint32_t wid) {
  cuResolveCapture();
  if(!cuCopySpaces || !cuCopyDisplayForWindow || !cuDisplaySpace || !cuMainConn) return nil;
  uint32_t cid = cuMainConn();
  NSArray *spaces = CFBridgingRelease(cuCopySpaces(cid, 0x7, (__bridge CFArrayRef)@[@(wid)]));
  CFStringRef display = cuCopyDisplayForWindow(cid, wid);
  if(!display) return spaces.count ? nil : @NO;
  uint64_t current = cuDisplaySpace(cid, display);
  CFRelease(display);
  if(!current || ![spaces isKindOfClass:NSArray.class]) return nil;
  return @([spaces containsObject:@(current)]);
}
static BOOL cuImageBlank(CGImageRef image) {
  if(!image || CGImageGetWidth(image) < 1 || CGImageGetHeight(image) < 1) return YES;
  enum { side = 48 };
  uint8_t px[side * side * 4];
  memset(px, 0, sizeof px);
  CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(px, side, side, 8, side * 4, rgb, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(rgb);
  if(!ctx) return NO;
  CGContextDrawImage(ctx, CGRectMake(0, 0, side, side), image);
  CGContextRelease(ctx);
  for(size_t i = 3; i < sizeof px; i += 4) if(px[i]) return NO;
  return YES;
}
static CGImageRef cuHWCaptureWindow(uint32_t wid) {
  cuResolveCapture();
  if(!cuHWCapture || !cuMainConn) return NULL;
  uint32_t window = wid;
  CFArrayRef images = cuHWCapture(cuMainConn(), &window, 1, (1u << 11) | (1u << 8));
  if(!images) return NULL;
  CGImageRef image = NULL;
  if(CFArrayGetCount(images) > 0) {
    CFTypeRef first = CFArrayGetValueAtIndex(images, 0);
    if(first && CFGetTypeID(first) == CGImageGetTypeID()) image = (CGImageRef)CFRetain(first);
  }
  CFRelease(images);
  return image;
}
static CGImageRef cuSCKCaptureWindow(uint32_t wid, NSString **why) API_AVAILABLE(macos(14.0)) {
  __block SCShareableContent *content = nil;
  __block NSError *error = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *c, NSError *e) { content = c; error = e; dispatch_semaphore_signal(sem); }];
  if(dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0) { *why = @"shareable content timed out"; return NULL; }
  if(!content) { *why = error.localizedDescription ?: @"no shareable content"; return NULL; }
  SCWindow *window = nil;
  for(SCWindow *w in content.windows) if(w.windowID == wid) { window = w; break; }
  if(!window) { *why = @"ScreenCaptureKit does not list the window"; return NULL; }
  SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  SCStreamConfiguration *config = [SCStreamConfiguration new];
  CGFloat scale = filter.pointPixelScale > 0 ? filter.pointPixelScale : 2;
  CGRect rect = filter.contentRect;
  if(rect.size.width < 1 || rect.size.height < 1) rect = window.frame;
  config.width = (size_t)MAX(1, llround(rect.size.width * scale));
  config.height = (size_t)MAX(1, llround(rect.size.height * scale));
  config.showsCursor = NO;
  config.ignoreShadowsSingleWindow = YES;
  __block CGImageRef image = NULL;
  [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef img, NSError *e) {
    if(img) image = CGImageRetain(img);
    error = e;
    dispatch_semaphore_signal(sem);
  }];
  if(dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) { *why = @"capture timed out"; return NULL; }
  if(!image) *why = error.localizedDescription ?: @"no image";
  return image;
}
static BOOL cuWriteImage(CGImageRef image, NSString *file, BOOL png) {
  CFURLRef url = (__bridge CFURLRef)[NSURL fileURLWithPath:file];
  CGImageDestinationRef dest = CGImageDestinationCreateWithURL(url, png ? CFSTR("public.png") : CFSTR("public.jpeg"), 1, NULL);
  if(!dest) return NO;
  NSDictionary *props = png ? @{} : @{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.85 };
  CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)props);
  BOOL ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  return ok;
}
static void cuAgentCapture(NSDictionary *req, void (^reply)(NSDictionary *)) {
  uint32_t wid = [req[@"window_id"] unsignedIntValue];
  NSString *file = req[@"file"];
  BOOL png = [req[@"format"] isEqual:@"png"];
  if(!wid || ![file isKindOfClass:NSString.class] || !file.length) { reply(@{ @"ok": @NO, @"error": @"bad_args" }); return; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    if(cuScreenLocked()) { reply(@{ @"ok": @NO, @"error": @"screen_locked" }); return; }
    NSNumber *onSpace = cuWindowOnCurrentSpace(wid);
    NSMutableArray *tried = [NSMutableArray array];
    CGImageRef image = NULL;
    NSString *route = nil;
    NSArray *order = [onSpace isEqual:@NO] ? @[@"window-backing-store", @"screencapturekit"] : @[@"screencapturekit", @"window-backing-store"];
    for(NSString *r in order) {
      NSString *why = nil;
      CGImageRef candidate = NULL;
      if([r isEqual:@"screencapturekit"]) {
        if(@available(macOS 14.0, *)) candidate = cuSCKCaptureWindow(wid, &why);
        else why = @"needs macOS 14";
      } else {
        candidate = cuHWCaptureWindow(wid);
        if(!candidate) why = @"no backing store image";
      }
      if(candidate && cuImageBlank(candidate)) { CGImageRelease(candidate); candidate = NULL; why = @"blank frame"; }
      [tried addObject:@{ @"route": r, @"ok": @(candidate != NULL), @"reason": why ?: NSNull.null }];
      if(candidate) { image = candidate; route = r; break; }
    }
    if(!image) { reply(@{ @"ok": @NO, @"error": @"capture_failed", @"tried": tried, @"on_current_space": onSpace ?: NSNull.null }); return; }
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    BOOL written = cuWriteImage(image, file, png);
    CGImageRelease(image);
    if(!written) { reply(@{ @"ok": @NO, @"error": @"write_failed", @"tried": tried }); return; }
    reply(@{ @"ok": @YES, @"route": route, @"pixels": @{ @"w": @(w), @"h": @(h) }, @"on_current_space": onSpace ?: NSNull.null, @"tried": tried });
  } });
}
static void cuAgentWrite(NSDictionary *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
  if(!data) return;
  dispatch_async(cuAgentWriteQ, ^{
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  });
}
static dispatch_queue_t cuCommandQ;
static NSMutableDictionary<NSNumber *, NSProgress *> *cuCommandJobs;
static void cuAgentExecute(NSDictionary *req, void (^reply)(NSDictionary *)) {
  NSNumber *rid=req[@"id"];
  NSString *tool=req[@"tool"];
  NSDictionary *args=req[@"args"];
  if(![rid isKindOfClass:NSNumber.class] || ![tool isKindOfClass:NSString.class] || ![args isKindOfClass:NSDictionary.class] ||
      [args[@"input_lease"] boolValue] || ([tool isEqual:@"key_event"] && [args[@"down"] boolValue])) {
    reply(@{@"ok":@NO,@"error":@"args: persistent commands require valid arguments and cannot own held input"}); return;
  }
  NSProgress *progress=[NSProgress progressWithTotalUnitCount:1];
  @synchronized(cuAgentLock) {
    if(cuCommandJobs.count>=64 || cuCommandJobs[rid]) { reply(@{@"ok":@NO,@"error":@"input_busy: the native command queue is full or this request already exists"}); return; }
    cuCommandJobs[rid]=progress;
  }
  dispatch_async(cuCommandQ, ^{ @autoreleasepool {
    cuCommandProgress=progress;
    NSDictionary *body;
    @try {
      cuCheckCancelled();
      NSMutableDictionary *input=[args mutableCopy]; input[@"owner_pipe"]=@NO;
      id result=execute(@{@"tool":tool,@"args":input});
      cuCheckCancelled();
      body=@{@"ok":@YES,@"data":result?:NSNull.null};
    } @catch(NSException *error) { body=@{@"ok":@NO,@"error":error.reason?:error.name}; }
    @finally {
      cuReleaseLease(); cuOwnerPipe=NO; cuCommandProgress=nil;
      @synchronized(cuAgentLock) { [cuCommandJobs removeObjectForKey:rid]; }
    }
    reply(body);
  } });
}
static void cuAgentHandle(NSDictionary *req) {
  id rid = req[@"id"] ?: NSNull.null;
  NSString *cmd = req[@"cmd"];
  void (^reply)(NSDictionary *) = ^(NSDictionary *body) {
    NSMutableDictionary *m = [body mutableCopy];
    m[@"id"] = rid;
    cuAgentWrite(m);
  };
  @try {
    if([cmd isEqual:@"hello"]) {
      cuAgentResolve();
      reply(@{ @"ok": @YES, @"agent": @1, @"capture": @1, @"native_rpc": @1, @"pid": @(getpid()), @"key_focus_guard": @(cuStealFocus && cuReleaseFocus && cuMainConn && cuKeyFocus ? 1 : 0),
               @"display_awake": @(cuPMCreate ? 1 : 0), @"accessibility": @(AXIsProcessTrusted()) });
    } else if([cmd isEqual:@"status"]) {
      NSDictionary *live = @{ @"screen_locked": @(cuScreenLocked()), @"front_pid": @(cuAgentFrontPid()), @"key_focus_pid": @(cuAgentKeyFocusPid()) };
      NSMutableDictionary *body = [@{ @"ok": @YES } mutableCopy];
      [body addEntriesFromDictionary:live];
      @synchronized(cuAgentLock) {
        [body addEntriesFromDictionary:@{ @"display_awake": @(cuAwakeId != 0), @"released": @(cuReleased), @"missed": @(cuMissed), @"reverted": @(cuReverted), @"restored": @(cuRestored) }];
      }
      reply(body);
    } else if([cmd isEqual:@"execute"]) cuAgentExecute(req, reply);
    else if([cmd isEqual:@"cancel"]) {
      @synchronized(cuAgentLock) { [cuCommandJobs[req[@"cancel_id"]] cancel]; }
      reply(@{@"ok":@YES});
    } else if([cmd isEqual:@"arm"]) reply(cuAgentArm(req));
    else if([cmd isEqual:@"settle"]) cuAgentSettle(req, reply);
    else if([cmd isEqual:@"wait_window"]) cuAgentWaitWindow(req, reply);
    else if([cmd isEqual:@"capture"]) cuAgentCapture(req, reply);
    else if([cmd isEqual:@"intent"]) {
      @synchronized(cuAgentLock) { cuEpoch++; cuLate = nil; [cuWatches removeAllObjects]; }
      reply(@{ @"ok": @YES });
    } else reply(@{ @"ok": @NO, @"error": @"unknown_command" });
  } @catch(NSException *e) { reply(@{ @"ok": @NO, @"error": e.reason ?: e.name }); }
}
static int cuAgentMain(void) {
  signal(SIGTERM, SIG_DFL);
  signal(SIGINT, SIG_DFL);
  cuAgentLock = [NSObject new];
  cuCommandQ=dispatch_queue_create("net.codewhale.computer-use.native",DISPATCH_QUEUE_SERIAL);
  cuCommandJobs=[NSMutableDictionary dictionary];
  cuWatches = [NSMutableDictionary dictionary];
  cuAgentQ = dispatch_queue_create("net.codewhale.computer-use.agent", DISPATCH_QUEUE_SERIAL);
  cuAgentWriteQ = dispatch_queue_create("net.codewhale.computer-use.agent.write", DISPATCH_QUEUE_SERIAL);
  cuGuards = [NSMutableDictionary dictionary];
  cuAgentActions = [NSMutableDictionary dictionary];
  cuTargetTaps = [NSMutableDictionary dictionary];
  cuAgentResolve();
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  NSMutableData *buffer = [NSMutableData data];
  dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  void (^shutdown)(void)=^{
      dispatch_source_cancel(source); cuCancelled=1;
      @synchronized(cuAgentLock) { for(NSProgress *job in cuCommandJobs.allValues) [job cancel]; }
      dispatch_async(cuCommandQ, ^{ dispatch_async(dispatch_get_main_queue(), ^{
        @synchronized(cuAgentLock) { if(cuAwakeId && cuPMRelease) cuPMRelease(cuAwakeId); cuAwakeId=0; }
        cuRemoveTap(cuFrontTap);
        for(NSValue *v in cuTargetTaps.allValues) cuRemoveTap((CFMachPortRef)v.pointerValue);
        exit(0);
      }); });
  };
  dispatch_source_set_event_handler(source, ^{ @autoreleasepool {
    uint8_t chunk[65536];
    ssize_t n = read(STDIN_FILENO, chunk, sizeof chunk);
    if(n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) { shutdown(); return; }
    if(n < 0) return;
    [buffer appendBytes:chunk length:(NSUInteger)n];
    if(buffer.length>16*1024*1024) { shutdown(); return; }
    while(YES) {
      NSRange nl = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, buffer.length)];
      if(nl.location == NSNotFound) break;
      NSData *line = [buffer subdataWithRange:NSMakeRange(0, nl.location)];
      [buffer replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
      id req = line.length ? [NSJSONSerialization JSONObjectWithData:line options:0 error:nil] : nil;
      if([req isKindOfClass:NSDictionary.class]) cuAgentHandle(req);
      else if(line.length) cuAgentWrite(@{ @"id": NSNull.null, @"ok": @NO, @"error": @"invalid_request" });
    }
  } });
  dispatch_resume(source);
  CFRunLoopTimerRef keepAlive = CFRunLoopTimerCreateWithHandler(NULL, CFAbsoluteTimeGetCurrent() + 1e9, 1e9, 0, 0, ^(CFRunLoopTimerRef t) {});
  CFRunLoopAddTimer(CFRunLoopGetMain(), keepAlive, kCFRunLoopCommonModes);
  while(YES) CFRunLoopRun();
  return 0;
}
int main(int argc, const char **argv){ @autoreleasepool {
  signal(SIGTERM,cuCancel); signal(SIGINT,cuCancel); signal(SIGPIPE,SIG_IGN);
  @try { if(argc!=2) @throw [NSException exceptionWithName:@"args" reason:@"expected one JSON argument" userInfo:nil];
    NSError *error=nil; id p=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
    if(![p isKindOfClass:NSDictionary.class]) @throw [NSException exceptionWithName:@"json" reason:@"invalid request" userInfo:nil];
    if([p[@"tool"] isEqual:@"agent"]) return cuAgentMain();
    id result=execute(p);
    if([p[@"args"][@"input_lease"] boolValue]) { NSMutableDictionary *ack=[result mutableCopy]; ack[@"input_lease"]=@YES; result=ack; }
    NSData *data=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:&error];
    if(!data) @throw [NSException exceptionWithName:@"json" reason:error.localizedDescription userInfo:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
    if([p[@"args"][@"input_lease"] boolValue]) cuWaitForLease();
    return 0;
  } @catch(NSException *e){ cuReleaseLease(); fprintf(stderr,"%s\n",e.reason.UTF8String); return 1; }
} }
