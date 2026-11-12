// Codewhale Computer Use — macOS bundle executable.
//
// macOS grants Accessibility / Screen Recording to the *responsible process*
// of a permission check. A shell-script launcher that exec()s node makes node
// the responsible process, so the grant lands on "node", not on the app. This
// tiny Mach-O stays alive as the app's process and runs node as its child:
// children inherit responsibility, so every osascript / screencapture the
// daemon spawns is attributed to "Codewhale Computer Use" and the app shows
// up by name and icon under System Settings → Privacy & Security.
//
// Built by scripts/build-app.mjs (clang, universal, ad-hoc signed) into
// assets/macos/codewhale-cu, which is committed so non-mac builds still work.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <glob.h>
#include <fcntl.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <sys/socket.h>
#include "control-panel.h"

extern char **environ;

static pid_t child = 0;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

static int executable(const char *p) {
  struct stat st;
  return p && *p && stat(p, &st) == 0 && S_ISREG(st.st_mode) && access(p, X_OK) == 0;
}

static void trim(char *s) {
  size_t n = strlen(s);
  while (n && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ')) s[--n] = 0;
}

/* Newest node under a versions dir (nvm / fnm layouts). */
static int newest_glob(const char *pattern, char *out, size_t cap) {
  glob_t g;
  int found = 0;
  if (glob(pattern, 0, NULL, &g) == 0) {
    for (size_t i = 0; i < g.gl_pathc; i++) {
      if (executable(g.gl_pathv[i])) { strlcpy(out, g.gl_pathv[i], cap); found = 1; } /* glob sorts; last wins */
    }
  }
  globfree(&g);
  return found;
}

static int find_node(const char *contents, const char *home, char *out, size_t cap) {
  snprintf(out, cap, "%s/MacOS/node", contents);
  if (executable(out)) return 1;
  char pinned[PATH_MAX];
  snprintf(pinned, sizeof pinned, "%s/Resources/node-path", contents);
  FILE *f = fopen(pinned, "r");
  if (f) {
    if (fgets(out, (int)cap, f)) { trim(out); if (executable(out)) { fclose(f); return 1; } }
    fclose(f);
  }
  const char *fixed[] = { "/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node", NULL };
  for (int i = 0; fixed[i]; i++) if (executable(fixed[i])) { strlcpy(out, fixed[i], cap); return 1; }
  const char *rel[] = { "/.volta/bin/node", "/.local/share/fnm/aliases/default/bin/node", "/.fnm/aliases/default/bin/node", NULL };
  for (int i = 0; rel[i]; i++) {
    snprintf(out, cap, "%s%s", home, rel[i]);
    if (executable(out)) return 1;
  }
  char pat[PATH_MAX];
  snprintf(pat, sizeof pat, "%s/.nvm/versions/node/*/bin/node", home);
  if (newest_glob(pat, out, cap)) return 1;
  snprintf(pat, sizeof pat, "%s/.local/share/fnm/node-versions/*/installation/bin/node", home);
  if (newest_glob(pat, out, cap)) return 1;
  /* PATH as launched (LaunchServices gives a minimal one, but try). */
  const char *path = getenv("PATH");
  if (path) {
    char *dup = strdup(path), *save = NULL;
    for (char *dir = strtok_r(dup, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
      snprintf(out, cap, "%s/node", dir);
      if (executable(out)) { free(dup); return 1; }
    }
    free(dup);
  }
  out[0] = 0;
  return 0;
}

static void alert(const char *message) {
  char script[512];
  snprintf(script, sizeof script, "display alert \"Codewhale Computer Use\" message \"%s\"", message);
  char *argv[] = { "/usr/bin/osascript", "-e", script, NULL };
  pid_t p;
  if (posix_spawn(&p, argv[0], NULL, NULL, argv, environ) == 0) waitpid(p, NULL, 0);
}

// The agent pointer is drawn in an app preview, never by moving the user's
// hardware pointer. The user's own cursor is drawn too (white, "you") so
// the preview shows where the hardware pointer actually is on screen.
// The nonactivating panel accepts no keyboard focus.
static NSColor *cuBrandCyan(void) { return [NSColor colorWithSRGBRed:0x69/255.0 green:0xDA/255.0 blue:0xE4/255.0 alpha:1]; }
static NSColor *cuBrandNavy(void) { return [NSColor colorWithSRGBRed:0x14/255.0 green:0x23/255.0 blue:0x3B/255.0 alpha:1]; }
// The Codewhale pointer: the cyan arrow from the app icon (assets/icon-*.svg,
// "M356 53 L446 121 L404 127 L385 165 Z"), translated so its tip is (x,y) in
// a flipped view. A white halo keeps it legible on dark content.
static void cuDrawAgentGlyph(CGFloat x, CGFloat y, CGFloat s) {
  NSBezierPath *p=[NSBezierPath bezierPath];
  [p moveToPoint:NSMakePoint(x,y)]; [p lineToPoint:NSMakePoint(x+90*s,y+68*s)];
  [p lineToPoint:NSMakePoint(x+48*s,y+74*s)]; [p lineToPoint:NSMakePoint(x+29*s,y+112*s)]; [p closePath];
  p.lineJoinStyle=NSLineJoinStyleRound;
  [NSGraphicsContext saveGraphicsState];
  NSShadow *shadow=[[NSShadow new] autorelease]; shadow.shadowBlurRadius=3; shadow.shadowOffset=NSMakeSize(0,-1);
  shadow.shadowColor=[NSColor colorWithCalibratedWhite:0 alpha:0.45]; [shadow set];
  [[NSColor colorWithCalibratedWhite:1 alpha:0.95] setStroke]; p.lineWidth=4; [p stroke];
  [NSGraphicsContext restoreGraphicsState];
  [cuBrandCyan() setFill]; [p fill];
  [cuBrandNavy() setStroke]; p.lineWidth=1.6; [p stroke];
}
static void cuDrawCursor(CGFloat x, CGFloat y, NSColor *fill, NSString *label) {
  if(fill==nil) cuDrawAgentGlyph(x,y,0.24);
  else {
    NSBezierPath *cursor=[NSBezierPath bezierPath];
    [cursor moveToPoint:NSMakePoint(x,y)]; [cursor lineToPoint:NSMakePoint(x+3,y+24)]; [cursor lineToPoint:NSMakePoint(x+10,y+17)]; [cursor lineToPoint:NSMakePoint(x+20,y+16)]; [cursor closePath];
    [fill setFill]; [cursor fill]; [[NSColor blackColor] setStroke]; cursor.lineWidth=1.5; [cursor stroke];
  }
  if(label) [label drawAtPoint:NSMakePoint(x+23,y+12) withAttributes:@{NSFontAttributeName:[NSFont boldSystemFontOfSize:12],NSForegroundColorAttributeName:fill?:cuBrandCyan(),NSBackgroundColorAttributeName:[NSColor colorWithCalibratedWhite:0.08 alpha:0.9]}];
}

// The agent's own on-screen pointer. It is a small click-through window that
// glides to wherever the agent acts; the user's hardware cursor never moves.
// Screen capture excludes it (sharingType none), so the agent's screenshots
// show the app, not its own cursor.
static const CGFloat kCUAgentCursorBox=96;
@interface CUAgentCursorView : NSView
@end
@implementation CUAgentCursorView
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty {
  CGFloat c=kCUAgentCursorBox/2;
  cuDrawAgentGlyph(c,c,0.24);
  NSImage *icon=NSApp.applicationIconImage;
  if(icon) [icon drawInRect:NSMakeRect(c+17,c+21,16,16) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:YES hints:nil];
}
- (void)pulse {
  CGFloat c=kCUAgentCursorBox/2, r=18;
  CAShapeLayer *ring=[CAShapeLayer layer];
  ring.bounds=CGRectMake(0,0,2*r,2*r); ring.position=CGPointMake(c,c);
  CGPathRef path=CGPathCreateWithEllipseInRect(ring.bounds,NULL); ring.path=path; CGPathRelease(path);
  ring.fillColor=[cuBrandCyan() colorWithAlphaComponent:0.25].CGColor;
  ring.strokeColor=cuBrandCyan().CGColor; ring.lineWidth=2; ring.opacity=0;
  [self.layer insertSublayer:ring atIndex:0];
  CABasicAnimation *scale=[CABasicAnimation animationWithKeyPath:@"transform.scale"]; scale.fromValue=@0.3; scale.toValue=@1.2;
  CABasicAnimation *fade=[CABasicAnimation animationWithKeyPath:@"opacity"]; fade.fromValue=@0.9; fade.toValue=@0;
  CAAnimationGroup *group=[CAAnimationGroup animation]; group.animations=@[scale,fade]; group.duration=0.4;
  group.timingFunction=[CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
  [CATransaction begin]; [CATransaction setCompletionBlock:^{ [ring removeFromSuperlayer]; }];
  [ring addAnimation:group forKey:@"pulse"];
  [CATransaction commit];
}
@end
@interface CUAgentCursorPanel : NSPanel
@end
@implementation CUAgentCursorPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end
@interface CUPreviewView : NSView
@property(retain) NSImage *image;
@property(retain) NSString *caption;
@property CGFloat pointerX;
@property CGFloat pointerY;
@property CGFloat userX;
@property CGFloat userY;
@end
@implementation CUPreviewView
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirty {
  [[NSColor colorWithCalibratedWhite:0.08 alpha:1] setFill]; NSRectFill(self.bounds);
  if (!self.image) return;
  NSSize size=self.image.size;
  CGFloat scale=MIN(self.bounds.size.width/size.width,self.bounds.size.height/size.height);
  NSRect frame=NSMakeRect((self.bounds.size.width-size.width*scale)/2,(self.bounds.size.height-size.height*scale)/2,size.width*scale,size.height*scale);
  [self.image drawInRect:frame fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:YES hints:nil];
  if(self.caption.length)
    [self.caption drawAtPoint:NSMakePoint(8,6) withAttributes:@{NSFontAttributeName:[NSFont boldSystemFontOfSize:11],NSForegroundColorAttributeName:[NSColor whiteColor],NSBackgroundColorAttributeName:[NSColor colorWithCalibratedWhite:0.08 alpha:0.75]}];
  if(self.pointerX>=0 && self.pointerX<=1 && self.pointerY>=0 && self.pointerY<=1)
    cuDrawCursor(frame.origin.x+self.pointerX*frame.size.width, frame.origin.y+self.pointerY*frame.size.height, nil, @"Codewhale");
  if(self.userX>=0 && self.userX<=1 && self.userY>=0 && self.userY<=1)
    cuDrawCursor(frame.origin.x+self.userX*frame.size.width, frame.origin.y+self.userY*frame.size.height,
      [NSColor whiteColor], @"you");
}
@end
@interface CUPreviewPanel : NSPanel
@end
@implementation CUPreviewPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface CUPreviewCloseButton : NSButton
@end
@implementation CUPreviewCloseButton
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end

static NSString *cuPreviewDirectory(void) {
  NSString *dir=NSProcessInfo.processInfo.environment[@"CODEWHALE_CU_STATE_DIR"];
  if(!dir.length) dir=[NSHomeDirectory() stringByAppendingPathComponent:@".codewhale-cu"];
  return [dir stringByAppendingPathComponent:@"preview"];
}

static NSRect cuPreviewFrame(NSRect screen) {
  CGFloat insetX=MIN(10,MAX(0,(NSWidth(screen)-38)/2));
  CGFloat insetY=MIN(10,MAX(0,(NSHeight(screen)-38)/2));
  CGFloat width=MIN(560,NSWidth(screen)-2*insetX), height=MIN(360,NSHeight(screen)-2*insetY);
  return NSMakeRect(NSMaxX(screen)-width-insetX,NSMinY(screen)+insetY,width,height);
}

@interface CUAppDelegate : NSObject <NSApplicationDelegate>
- (void)pollChild:(NSTimer *)timer;
- (void)updatePreview:(NSNotification *)notification;
- (void)dismissPreview:(id)sender;
- (void)expirePreview:(NSTimer *)timer;
- (void)updateAgentCursor:(NSNotification *)notification;
@property(retain) CUPreviewPanel *previewPanel;
@property(retain) CUAgentCursorPanel *cursorPanel;
@property(retain) CUAgentCursorView *cursorView;
@property(retain) NSTimer *cursorIdle;
@property(retain) CUPreviewView *previewView;
@property(retain) NSTimer *previewTimer;
@property(copy) NSString *previewOwner;
@property(retain) NSMutableSet *retiredPreviews;
@property BOOL legacyPreviewDismissed;
@property(retain) CUControlPanel *controls;
@end
@implementation CUAppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.controls=[CUControlPanel new]; [self.controls start];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
  [self.controls show:nil]; return YES;
}
- (void)dismissPreview:(id)sender {
  if(!self.previewPanel.isVisible) return;
  NSString *owner=self.previewOwner;
  if(owner && ![owner isEqualToString:@"legacy"]) {
    [self.retiredPreviews addObject:owner];
    NSString *marker=[cuPreviewDirectory() stringByAppendingPathComponent:[owner stringByAppendingString:@".dismissed"]];
    [@"dismissed" writeToFile:marker atomically:YES encoding:NSUTF8StringEncoding error:nil];
  } else self.legacyPreviewDismissed=YES;
  [self.previewTimer invalidate]; self.previewTimer=nil;
  [self.previewPanel orderOut:nil]; self.previewOwner=nil; self.controls.previewItem.enabled=NO;
}
- (void)expirePreview:(NSTimer *)timer {
  [self.previewPanel orderOut:nil]; self.previewOwner=nil; self.previewTimer=nil; self.controls.previewItem.enabled=NO;
}
- (void)updatePreview:(NSNotification *)notification {
  NSDictionary *data=notification.userInfo;
  NSString *owner=[data[@"owner"] isKindOfClass:NSString.class]?data[@"owner"]:nil;
  if(owner && ![[[NSUUID alloc] initWithUUIDString:owner] autorelease]) return;
  NSString *key=owner?:@"legacy";
  if(!self.retiredPreviews) self.retiredPreviews=[NSMutableSet set];
  if (![data[@"enabled"] boolValue]) {
    if(owner) [self.retiredPreviews addObject:owner]; else self.legacyPreviewDismissed=NO;
    if([self.previewOwner isEqualToString:key]) {
      [self.previewTimer invalidate]; self.previewTimer=nil;
      [self.previewPanel orderOut:nil]; self.previewOwner=nil; self.controls.previewItem.enabled=NO;
    }
    return;
  }
  if(owner && ([self.retiredPreviews containsObject:owner] || [[NSFileManager defaultManager] fileExistsAtPath:[cuPreviewDirectory() stringByAppendingPathComponent:[owner stringByAppendingString:@".dismissed"]]])) return;
  if(!owner && self.legacyPreviewDismissed) return;
  if(![data[@"show"] boolValue] && ![self.previewOwner isEqualToString:key]) return;
  if([data[@"show"] boolValue]) self.previewOwner=key;
  if (!self.previewPanel) {
    NSScreen *screen=NSScreen.mainScreen?:NSScreen.screens.firstObject;
    if(!screen) return;
    NSRect frame=cuPreviewFrame(screen.visibleFrame);
    self.previewPanel=[[CUPreviewPanel alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    self.previewPanel.releasedWhenClosed=NO; self.previewPanel.hidesOnDeactivate=NO;
    self.previewPanel.movableByWindowBackground=YES; self.previewPanel.hasShadow=YES;
    self.previewPanel.opaque=NO; self.previewPanel.backgroundColor=[NSColor clearColor];
    self.previewView=[[CUPreviewView alloc] initWithFrame:NSMakeRect(0,0,NSWidth(frame),NSHeight(frame))];
    self.previewView.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    self.previewView.wantsLayer=YES; self.previewView.layer.cornerRadius=10; self.previewView.layer.masksToBounds=YES;
    self.previewPanel.contentView=self.previewView;
    CUPreviewCloseButton *close=[[[CUPreviewCloseButton alloc] initWithFrame:NSMakeRect(MAX(0,NSWidth(frame)-38),MIN(8,MAX(0,NSHeight(frame)-30)),MIN(30,NSWidth(frame)),MIN(30,NSHeight(frame)))] autorelease];
    close.bordered=NO; close.image=[NSImage imageWithSystemSymbolName:@"xmark.circle.fill" accessibilityDescription:@"Close preview"];
    close.contentTintColor=NSColor.whiteColor; close.toolTip=@"Close preview";
    [close setAccessibilityLabel:@"Close preview"];
    close.wantsLayer=YES; close.layer.backgroundColor=[NSColor colorWithCalibratedWhite:0.08 alpha:0.8].CGColor; close.layer.cornerRadius=15;
    close.autoresizingMask=NSViewMinXMargin|NSViewMaxYMargin;
    close.target=self; close.action=@selector(dismissPreview:);
    [self.previewView addSubview:close];
  }
  NSString *file=[cuPreviewDirectory() stringByAppendingPathComponent:owner?[owner stringByAppendingString:@".png"]:@"latest.png"];
  self.previewView.image=[[[NSImage alloc] initWithContentsOfFile:file] autorelease];
  self.previewView.pointerX=data[@"x"]?[data[@"x"] doubleValue]:-1; self.previewView.pointerY=data[@"y"]?[data[@"y"] doubleValue]:-1;
  self.previewView.userX=data[@"user_x"]?[data[@"user_x"] doubleValue]:-1; self.previewView.userY=data[@"user_y"]?[data[@"user_y"] doubleValue]:-1;
  self.previewView.caption=[data[@"title"] isKindOfClass:NSString.class]?data[@"title"]:@"Codewhale activity";
  [self.previewView setNeedsDisplay:YES];
  BOOL show=[data[@"show"] boolValue];
  if(show || self.previewPanel.isVisible) {
    BOOL onScreen=NO;
    for(NSScreen *screen in NSScreen.screens) if(NSContainsRect(screen.visibleFrame,self.previewPanel.frame)) { onScreen=YES; break; }
    NSScreen *screen=NSScreen.mainScreen?:NSScreen.screens.firstObject;
    if(!onScreen && screen) [self.previewPanel setFrame:cuPreviewFrame(screen.visibleFrame) display:NO];
  }
  if(show) {
    [self.previewPanel orderFrontRegardless]; self.controls.previewItem.enabled=YES;
  }
  [self.previewTimer invalidate];
  self.previewTimer=[NSTimer scheduledTimerWithTimeInterval:65 target:self selector:@selector(expirePreview:) userInfo:nil repeats:NO];
}
// userInfo: {x, y} in global top-left screen points (the space every action
// target uses), click:bool, glide_ms; or {hide:true}. An idle cursor fades
// so a session that died without hiding it does not leave one behind.
- (void)updateAgentCursor:(NSNotification *)notification {
  NSDictionary *data=notification.userInfo;
  if([data[@"hide"] boolValue]) { [self hideAgentCursor:nil]; return; }
  double x=[data[@"x"] doubleValue], y=[data[@"y"] doubleValue];
  if(![data[@"x"] isKindOfClass:NSNumber.class] || ![data[@"y"] isKindOfClass:NSNumber.class] || !isfinite(x) || !isfinite(y)) return;
  if(!self.cursorPanel) {
    CGFloat b=kCUAgentCursorBox;
    self.cursorPanel=[[[CUAgentCursorPanel alloc] initWithContentRect:NSMakeRect(0,0,b,b) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO] autorelease];
    CUAgentCursorPanel *w=self.cursorPanel;
    w.releasedWhenClosed=NO; w.hidesOnDeactivate=NO; w.opaque=NO; w.hasShadow=NO;
    w.backgroundColor=[NSColor clearColor]; w.ignoresMouseEvents=YES; w.level=NSScreenSaverWindowLevel;
    w.sharingType=NSWindowSharingNone; w.title=@"Codewhale agent cursor";
    w.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle|NSWindowCollectionBehaviorFullScreenAuxiliary;
    self.cursorView=[[[CUAgentCursorView alloc] initWithFrame:NSMakeRect(0,0,b,b)] autorelease];
    self.cursorView.wantsLayer=YES; w.contentView=self.cursorView;
  }
  CUAgentCursorPanel *w=self.cursorPanel;
  CGFloat b=kCUAgentCursorBox, top=NSMaxY(NSScreen.screens.firstObject.frame);
  NSRect target=NSMakeRect(round(x-b/2),round(top-y-b/2),b,b);
  BOOL click=[data[@"click"] boolValue];
  double glide=MIN(MAX([data[@"glide_ms"] doubleValue],0),600)/1000.0;
  [self.cursorIdle invalidate];
  self.cursorIdle=[NSTimer scheduledTimerWithTimeInterval:8 target:self selector:@selector(hideAgentCursor:) userInfo:nil repeats:NO];
  CUAgentCursorView *view=self.cursorView;
  if(!w.isVisible || w.alphaValue<0.05) {
    [w setFrame:target display:NO]; w.alphaValue=0; [w orderFrontRegardless];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx){ ctx.duration=MAX(glide,0.12); [[w animator] setAlphaValue:1]; }
                        completionHandler:^{ if(click) [view pulse]; }];
    return;
  }
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx){
    ctx.duration=glide; ctx.timingFunction=[CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [[w animator] setFrame:target display:YES]; [[w animator] setAlphaValue:1];
  } completionHandler:^{ if(click) [view pulse]; }];
}
- (void)hideAgentCursor:(NSTimer *)timer {
  if(!timer) [self.cursorIdle invalidate];
  self.cursorIdle=nil;
  CUAgentCursorPanel *w=self.cursorPanel;
  if(!w.isVisible) return;
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx){ ctx.duration=0.25; [[w animator] setAlphaValue:0]; }
                      completionHandler:^{ if(!self.cursorIdle && w.alphaValue<0.05) [w orderOut:nil]; }];
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  forward(SIGTERM);
  return NSTerminateNow;
}
- (void)pollChild:(NSTimer *)timer {
  int status = 0;
  if (waitpid(child, &status, WNOHANG) == child)
    exit(WIFEXITED(status) ? WEXITSTATUS(status) : 1);
}
@end

int main(void) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  CUAppDelegate *delegate = [CUAppDelegate new];
  [NSApp setDelegate:delegate];
  [[NSDistributedNotificationCenter defaultCenter] addObserver:delegate selector:@selector(updatePreview:) name:@"net.codewhale.computer-use.preview" object:nil];
  [[NSDistributedNotificationCenter defaultCenter] addObserver:delegate selector:@selector(updateAgentCursor:) name:@"net.codewhale.computer-use.agent-cursor" object:nil];
  char exe[PATH_MAX];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0) return 1;
  char real[PATH_MAX];
  if (!realpath(exe, real)) return 1;
  char macos_dir[PATH_MAX], contents[PATH_MAX], bundle[PATH_MAX];
  strlcpy(macos_dir, dirname(real), sizeof macos_dir);
  strlcpy(contents, dirname(macos_dir), sizeof contents);
  strlcpy(bundle, dirname(contents), sizeof bundle);

  const char *home = getenv("HOME");
  if (!home || !*home) home = "/tmp";

  char logdir[PATH_MAX], logfile[PATH_MAX];
  snprintf(logdir, sizeof logdir, "%s/Library/Logs/Codewhale Computer Use", home);
  mkdir(logdir, 0755);
  snprintf(logfile, sizeof logfile, "%s/app.log", logdir);
  int log = open(logfile, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (log >= 0) { dup2(log, STDOUT_FILENO); dup2(log, STDERR_FILENO); close(log); }

  // Permission prompts are attached to the person's setup buttons. An MCP
  // background launch must not interrupt them with System Settings dialogs.

  char node[PATH_MAX];
  if (!find_node(contents, home, node, sizeof node)) {
    fprintf(stderr, "Codewhale Computer Use: Node.js 20+ not found\n");
    alert("Node.js 20 or newer was not found. Install it from nodejs.org, then open the app again.");
    return 1;
  }

  char daemon[PATH_MAX];
  snprintf(daemon, sizeof daemon, "%s/Resources/plugin/app/daemon.mjs", contents);
  setenv("CODEWHALE_CU_APP_BUNDLE", bundle, 1);

  char *argv[] = { node, daemon, NULL };
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  int control[2];
  if(socketpair(AF_UNIX,SOCK_STREAM,0,control)!=0) { alert("Could not create the local safety controls. Reopen the app to retry."); return 1; }
  cuControlFD=control[0];
  fcntl(cuControlFD,F_SETFL,fcntl(cuControlFD,F_GETFL)|O_NONBLOCK);
  fcntl(cuControlFD,F_SETFD,FD_CLOEXEC);
  int noSigpipe=1; setsockopt(cuControlFD,SOL_SOCKET,SO_NOSIGPIPE,&noSigpipe,sizeof noSigpipe);
  posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
  // Close the parent's end before dup2; it can itself be descriptor 3.
  posix_spawn_file_actions_addclose(&actions,control[0]);
  posix_spawn_file_actions_adddup2(&actions,control[1],3);
  if(control[1]!=3) posix_spawn_file_actions_addclose(&actions,control[1]);
  setenv("CODEWHALE_CU_CONTROL_FD","3",1);
  int rc = posix_spawn(&child, node, &actions, &attr, argv, environ);
  unsetenv("CODEWHALE_CU_CONTROL_FD");
  posix_spawn_file_actions_destroy(&actions); close(control[1]);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    fprintf(stderr, "Codewhale Computer Use: could not start %s: %s\n", node, strerror(rc));
    return 1;
  }
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);

  // Process standard macOS Quit/Reopen events instead of blocking in waitpid.
  dispatch_source_t childExit = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)child, DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  dispatch_source_set_event_handler(childExit, ^{ [delegate pollChild:nil]; });
  dispatch_resume(childExit);
  [delegate pollChild:nil];
  [NSApp run];
  forward(SIGTERM);
  return 0;
}
