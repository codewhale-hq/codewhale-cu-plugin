#import <QuartzCore/QuartzCore.h>
#include <math.h>

@interface CUSessionPillWindow : NSPanel
@end
@implementation CUSessionPillWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface CUSessionPillController : NSObject
@property(retain) CUSessionPillWindow *panel;
@property(retain) NSButton *button;
@property(retain) NSButton *stopButton;
@property(retain) NSTimer *timer;
@property(retain) NSDictionary *state;
@property(retain) NSDictionary *session;
@property(assign) id controlTarget;
@property(assign) NSTimeInterval nextGeometryCheck;
- (void)updateWithState:(NSDictionary *)state controlTarget:(id)target;
- (void)invalidate;
@end

@implementation CUSessionPillController
- (void)buildPanel {
  self.panel=[[[CUSessionPillWindow alloc] initWithContentRect:NSMakeRect(0,0,188,30) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO] autorelease];
  self.panel.title=@"Codewhale Computer Use";
  self.panel.opaque=NO; self.panel.backgroundColor=NSColor.clearColor;
  self.panel.hasShadow=YES; self.panel.hidesOnDeactivate=NO;
  self.panel.level=NSFloatingWindowLevel;
  self.panel.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorIgnoresCycle;
  self.panel.animationBehavior=NSWindowAnimationBehaviorNone;
  self.panel.releasedWhenClosed=NO;
  self.button=cuButton(@"Codewhale",self,@selector(showMenu:));
  self.panel.contentView.wantsLayer=YES; self.panel.contentView.layer.cornerRadius=15;
  self.panel.contentView.layer.backgroundColor=NSColor.systemBlueColor.CGColor;
  self.button.frame=NSMakeRect(0,0,154,30);
  self.button.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
  self.button.bordered=NO; self.button.font=[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
  self.button.image=[NSImage imageWithSystemSymbolName:@"person.crop.rectangle" accessibilityDescription:nil]?:[NSImage imageWithSystemSymbolName:@"display" accessibilityDescription:nil];
  self.button.imagePosition=NSImageLeft; self.button.contentTintColor=NSColor.whiteColor;
  self.button.wantsLayer=YES; self.button.layer.cornerRadius=15;
  self.button.layer.backgroundColor=NSColor.systemBlueColor.CGColor;
  self.button.cell.lineBreakMode=NSLineBreakByTruncatingTail;
  [self.panel.contentView addSubview:self.button];
  self.stopButton=cuButton(@"",self,@selector(stop:));
  self.stopButton.frame=NSMakeRect(154,0,34,30); self.stopButton.bordered=NO;
  self.stopButton.image=[NSImage imageWithSystemSymbolName:@"stop.fill" accessibilityDescription:nil];
  self.stopButton.contentTintColor=NSColor.whiteColor;
  self.stopButton.accessibilityLabel=@"Stop computer use"; self.stopButton.toolTip=@"Stop computer use";
  [self.panel.contentView addSubview:self.stopButton];
}
- (void)updateWithState:(NSDictionary *)state controlTarget:(id)target {
  self.state=state; self.controlTarget=target;
  NSDictionary *selected=nil; NSInteger priority=-1;
  pid_t front=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  if([state[@"mode"] isEqual:@"ready"] || [state[@"mode"] isEqual:@"paused"]) {
    for(NSDictionary *candidate in state[@"sessions"]) {
      if(![candidate isKindOfClass:NSDictionary.class] || ![candidate[@"sessionId"] isKindOfClass:NSString.class] || ![candidate[@"sessionId"] length] || ![candidate[@"target"] isKindOfClass:NSDictionary.class]) continue;
      if(![candidate[@"target"][@"pid"] isKindOfClass:NSNumber.class] || [candidate[@"target"][@"pid"] intValue]<=0) continue;
      BOOL active=[candidate[@"action"] isKindOfClass:NSString.class];
      BOOL current=[candidate[@"sessionId"] isEqual:self.session[@"sessionId"]];
      BOOL inFront=[candidate[@"target"][@"pid"] intValue]==front;
      NSInteger score=(active?4:0)+(inFront?2:0)+(current?1:0);
      if(score>priority) { selected=candidate; priority=score; }
    }
  }
  if(![selected[@"sessionId"] isEqual:self.session[@"sessionId"]] || ![selected[@"target"][@"pid"] isEqual:self.session[@"target"][@"pid"]]) { [self.panel orderOut:nil]; self.nextGeometryCheck=0; }
  self.session=selected;
  if(!selected) { [self invalidate]; return; }
  if(!self.panel) [self buildPanel];
  NSString *name=[selected[@"target"][@"name"] isKindOfClass:NSString.class]?selected[@"target"][@"name"]:@"Application";
  NSString *status=[state[@"cleanupPending"] boolValue]?@"Releasing input":[state[@"mode"] isEqual:@"paused"]?@"Paused":selected[@"action"]!=NSNull.null && [selected[@"action"] isKindOfClass:NSString.class]?@"Working":@"Connected";
  self.button.title=[state[@"mode"] isEqual:@"paused"]?@"Paused":[status isEqual:@"Working"]?[@"Using " stringByAppendingString:name]:[name stringByAppendingString:@" · Ready"];
  self.stopButton.enabled=![state[@"cleanupPending"] boolValue];
  self.button.accessibilityLabel=[NSString stringWithFormat:@"Codewhale Computer Use, %@, %@. Open controls",name,status];
  self.button.toolTip=[NSString stringWithFormat:@"%@ · %@",name,status];
  if(!self.timer) self.timer=[NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
  [self tick:nil];
}
- (void)showFallback {
  NSScreen *screen=NSScreen.mainScreen?:NSScreen.screens.firstObject;
  if(!screen) { [self.panel orderOut:nil]; return; }
  NSRect visible=screen.visibleFrame;
  [self.panel setFrame:NSMakeRect(NSMaxX(visible)-200,NSMaxY(visible)-42,188,30) display:YES];
  [self.panel orderFrontRegardless];
}
- (void)tick:(NSTimer *)timer {
  NSTimeInterval now=NSProcessInfo.processInfo.systemUptime;
  if(now<self.nextGeometryCheck) return;
  self.nextGeometryCheck=now+(self.panel.visible?0.25:1.0);
  pid_t pid=[self.session[@"target"][@"pid"] intValue];
  NSRunningApplication *running=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if(!running || running.terminated) { [self.panel orderOut:nil]; return; }
  if(running.hidden || !AXIsProcessTrusted()) { [self showFallback]; return; }
  AXUIElementRef app=AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app,0.04);
  CFTypeRef window=NULL;
  AXError result=AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute,&window);
  if(result!=kAXErrorSuccess || !window) {
    if(window) CFRelease(window); window=NULL;
    result=AXUIElementCopyAttributeValue(app,kAXMainWindowAttribute,&window);
  }
  CFRelease(app);
  if(result!=kAXErrorSuccess || !window || CFGetTypeID(window)!=AXUIElementGetTypeID()) { if(window) CFRelease(window); [self showFallback]; return; }
  AXUIElementSetMessagingTimeout((AXUIElementRef)window,0.04);
  CFArrayRef values=NULL;
  result=AXUIElementCopyMultipleAttributeValues((AXUIElementRef)window,(CFArrayRef)@[(__bridge NSString *)kAXPositionAttribute,(__bridge NSString *)kAXSizeAttribute,(__bridge NSString *)kAXMinimizedAttribute],kAXCopyMultipleAttributeOptionStopOnError,&values);
  CFRelease(window);
  CGPoint origin=CGPointZero; CGSize size=CGSizeZero; BOOL valid=NO;
  if(result==kAXErrorSuccess && values && CFArrayGetCount(values)==3) {
    CFTypeRef position=CFArrayGetValueAtIndex(values,0), dimensions=CFArrayGetValueAtIndex(values,1), minimized=CFArrayGetValueAtIndex(values,2);
    valid=CFGetTypeID(position)==AXValueGetTypeID() && CFGetTypeID(dimensions)==AXValueGetTypeID() && CFGetTypeID(minimized)==CFBooleanGetTypeID() && !CFBooleanGetValue((CFBooleanRef)minimized) && AXValueGetValue((AXValueRef)position,kAXValueCGPointType,&origin) && AXValueGetValue((AXValueRef)dimensions,kAXValueCGSizeType,&size);
  }
  if(values) CFRelease(values);
  if(!valid || !isfinite(origin.x) || !isfinite(origin.y) || !isfinite(size.width) || !isfinite(size.height) || size.width<170 || size.height<40) { [self showFallback]; return; }
  CGRect bounds=CGRectMake(origin.x,origin.y,size.width,size.height);
  CFArrayRef windows=CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID);
  BOOL onScreen=NO, covered=NO;
  CGRect edge=CGRectMake(origin.x+12,origin.y,MIN(size.width-24,240),36);
  for(NSDictionary *info in (NSArray *)windows) {
    CGRect frame=CGRectZero;
    if(!CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)info[(id)kCGWindowBounds],&frame)) continue;
    pid_t owner=[info[(id)kCGWindowOwnerPID] intValue];
    if(owner==pid && fabs(frame.origin.x-origin.x)<2 && fabs(frame.origin.y-origin.y)<2 && fabs(frame.size.width-size.width)<2 && fabs(frame.size.height-size.height)<2) { onScreen=YES; break; }
    if(owner!=getpid() && [info[(id)kCGWindowLayer] intValue]==0 && CGRectIntersectsRect(frame,edge)) covered=YES;
  }
  if(windows) CFRelease(windows);
  if(!onScreen || covered || NSScreen.screens.count==0) { [self showFallback]; return; }
  CGFloat top=NSMaxY(NSScreen.screens.firstObject.frame);
  NSRect appFrame=NSMakeRect(bounds.origin.x,top-CGRectGetMaxY(bounds),bounds.size.width,bounds.size.height);
  NSScreen *screen=nil;
  for(NSScreen *candidate in NSScreen.screens) if(NSIntersectsRect(candidate.visibleFrame,appFrame) && (!screen || NSWidth(NSIntersectionRect(candidate.visibleFrame,appFrame))*NSHeight(NSIntersectionRect(candidate.visibleFrame,appFrame))>NSWidth(NSIntersectionRect(screen.visibleFrame,appFrame))*NSHeight(NSIntersectionRect(screen.visibleFrame,appFrame)))) screen=candidate;
  if(!screen) { [self showFallback]; return; }
  NSRect visible=screen.visibleFrame;
  CGFloat y=NSMaxY(appFrame)+5, x=NSMinX(appFrame)+12;
  if(y+30>NSMaxY(visible)) {
    if(NSWidth(appFrame)<284) { [self showFallback]; return; }
    y=NSMaxY(appFrame)-34; x=NSMinX(appFrame)+84;
  }
  x=MAX(NSMinX(visible)+4,MIN(x,NSMaxX(visible)-192));
  NSRect frame=NSMakeRect(x,y,188,30);
  if(!NSContainsRect(visible,frame)) { [self showFallback]; return; }
  [self.panel setFrame:frame display:YES];
  [self.panel orderFrontRegardless];
}
- (void)showMenu:(id)sender {
  if(!self.session) return;
  NSMenu *menu=[[[NSMenu alloc] initWithTitle:@"Codewhale Computer Use"] autorelease]; menu.autoenablesItems=NO;
  NSMenuItem *label=[menu addItemWithTitle:self.button.toolTip?:@"Computer Use" action:nil keyEquivalent:@""]; label.enabled=NO;
  [menu addItem:NSMenuItem.separatorItem];
  NSMenuItem *pause=[menu addItemWithTitle:[self.state[@"mode"] isEqual:@"paused"]?@"Resume computer use":@"Pause computer use" action:@selector(pause:) keyEquivalent:@""]; pause.target=self; pause.enabled=![self.state[@"cleanupPending"] boolValue];
  NSMenuItem *stop=[menu addItemWithTitle:@"Stop computer use" action:@selector(stop:) keyEquivalent:@""]; stop.target=self; stop.enabled=![self.state[@"cleanupPending"] boolValue];
  [menu addItem:NSMenuItem.separatorItem];
  NSMenuItem *setup=[menu addItemWithTitle:@"Computer Use…" action:@selector(show:) keyEquivalent:@""]; setup.target=self.controlTarget;
  [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0,NSHeight(self.button.bounds)) inView:self.button];
}
- (void)pause:(id)sender { cuSend([self.state[@"mode"] isEqual:@"paused"]?@"resume":@"pause"); }
- (void)stop:(id)sender { cuSend(@"stop"); }
- (void)invalidate { [self.timer invalidate]; self.timer=nil; [self.panel orderOut:nil]; self.session=nil; self.nextGeometryCheck=0; }
- (void)dealloc {
  [self invalidate]; [self.panel release]; [self.button release]; [self.stopButton release]; [self.state release]; [super dealloc];
}
@end
