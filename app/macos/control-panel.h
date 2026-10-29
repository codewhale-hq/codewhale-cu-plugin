// Native setup and safety controls. Commands travel only over the inherited
// parent/child socketpair; they are deliberately absent from the MCP surface.
#include <sys/socket.h>

static int cuControlFD=-1;
static NSMutableData *cuControlBuffer;
static NSMutableData *cuControlOutput;
static dispatch_source_t cuControlReader;
static dispatch_source_t cuControlWriter;
static BOOL cuControlWriterSuspended=YES;
static void cuFlushControl(void) {
  while(cuControlFD>=0 && cuControlOutput.length) {
    ssize_t sent=write(cuControlFD,cuControlOutput.bytes,cuControlOutput.length);
    if(sent>0) [cuControlOutput replaceBytesInRange:NSMakeRange(0,(NSUInteger)sent) withBytes:NULL length:0];
    else if(sent<0 && errno==EINTR) continue;
    else if(sent<0 && (errno==EAGAIN || errno==EWOULDBLOCK)) break;
    else { [cuControlOutput setLength:0]; shutdown(cuControlFD,SHUT_RDWR); break; }
  }
  if(!cuControlWriter) return;
  if(cuControlOutput.length && cuControlWriterSuspended) { cuControlWriterSuspended=NO; dispatch_resume(cuControlWriter); }
  else if(!cuControlOutput.length && !cuControlWriterSuspended) { cuControlWriterSuspended=YES; dispatch_suspend(cuControlWriter); }
}
static void cuSendJSON(NSDictionary *payload) {
  if(cuControlFD<0) return;
  NSData *json=[NSJSONSerialization dataWithJSONObject:payload options:0 error:nil]; if(!json) return;
  if(!cuControlOutput) cuControlOutput=[NSMutableData new];
  if(json.length>=65536 || cuControlOutput.length+json.length+1>262144) { shutdown(cuControlFD,SHUT_RDWR); return; }
  [cuControlOutput appendData:json]; [cuControlOutput appendBytes:"\n" length:1];
  cuFlushControl();
}
static void cuSend(NSString *command) { cuSendJSON(@{@"command":command}); }
static NSTextField *cuLabel(NSString *text, CGFloat size, NSFontWeight weight) {
  NSTextField *label=[NSTextField wrappingLabelWithString:text];
  label.font=[NSFont systemFontOfSize:size weight:weight];
  label.translatesAutoresizingMaskIntoConstraints=NO;
  return label;
}
static NSStackView *cuStack(NSArray *views, NSUserInterfaceLayoutOrientation orientation, CGFloat spacing) {
  NSStackView *stack=[NSStackView stackViewWithViews:views];
  stack.orientation=orientation; stack.spacing=spacing; stack.alignment=orientation==NSUserInterfaceLayoutOrientationVertical?NSLayoutAttributeLeading:NSLayoutAttributeCenterY;
  stack.translatesAutoresizingMaskIntoConstraints=NO; return stack;
}
static NSButton *cuButton(NSString *title, id target, SEL action) {
  NSButton *button=[NSButton buttonWithTitle:title target:target action:action];
  button.bezelStyle=NSBezelStyleRounded; button.controlSize=NSControlSizeRegular; return button;
}
static NSView *cuSeparator(void) {
  NSBox *line=[NSBox new]; line.boxType=NSBoxSeparator; line.translatesAutoresizingMaskIntoConstraints=NO; return line;
}

#include "host-trust.h"
#include "consent-panel.h"
#include "session-pill.h"

@interface CUControlDocumentView : NSView
@end
@implementation CUControlDocumentView
- (BOOL)isFlipped { return YES; }
@end

@interface CUControlWindow : NSWindow
@end
@implementation CUControlWindow
- (BOOL)makeFirstResponder:(NSResponder *)responder {
  BOOL accepted=[super makeFirstResponder:responder];
  if(accepted && [responder isKindOfClass:NSView.class]) [(NSView *)responder scrollRectToVisible:[(NSView *)responder bounds]];
  return accepted;
}
@end

@interface CUControlPanel : NSObject <NSMenuDelegate, NSWindowDelegate>
@property(retain) CUConsentPanel *consent;
@property(retain) CUSessionPillController *sessionPill;
@property(retain) NSStatusItem *item;
@property(retain) NSTimer *timer;
@property(retain) NSWindow *window;
@property(retain) NSScrollView *bodyScroll;
@property(retain) NSView *bodyDocument;
@property(retain) NSStackView *body;
@property(retain) NSTextField *accessStatus;
@property(retain) NSTextField *screenStatus;
@property(retain) NSTextField *activity;
@property(retain) NSTextField *targets;
@property(retain) NSTextField *checkResult;
@property(retain) NSTextField *errorLabel;
@property(retain) NSTextField *updateStatus;
@property(retain) NSTextField *trustError;
@property(retain) NSStackView *hostRows;
@property(retain) NSScrollView *hostsScroll;
@property(retain) NSLayoutConstraint *hostsHeight;
@property(retain) NSDictionary *renderedHosts;
@property(retain) LAContext *trustAuthContext;
@property(copy) NSString *trustActionError;
@property(retain) NSButton *accessButton;
@property(retain) NSButton *screenButton;
@property(retain) NSButton *checkButton;
@property(retain) NSButton *pauseButton;
@property(retain) NSButton *stopButton;
@property(retain) NSButton *updateButton;
@property(retain) NSMenuItem *previewItem;
@property(retain) NSMenuItem *pauseItem;
@property(retain) NSMenuItem *stopItem;
@property(retain) NSDictionary *state;
@property(retain) NSStackView *setupSection;
@property(retain) NSStackView *settingsSection;
@property(retain) NSStackView *activityButtons;
@property(retain) NSButton *settingsButton;
@property(retain) NSButton *historyButton;
@property(assign) BOOL settingsVisible;
- (void)start;
- (void)show:(id)sender;
- (void)tick:(NSTimer *)timer;
- (void)drain;
- (void)renderHosts;
@end
@implementation CUControlPanel
- (NSView *)permissionRow:(NSString *)name detail:(NSString *)detail status:(NSTextField **)status button:(NSButton **)button action:(SEL)action {
  *status=cuLabel(@"Checking…",12,NSFontWeightRegular); (*status).textColor=NSColor.secondaryLabelColor;
  NSStackView *text=cuStack(@[cuLabel(name,13,NSFontWeightSemibold),*status],NSUserInterfaceLayoutOrientationVertical,3);
  *button=cuButton(@"Open Settings",self,action); (*button).accessibilityLabel=[@"Set up " stringByAppendingString:name];
  NSStackView *row=cuStack(@[text,*button],NSUserInterfaceLayoutOrientationHorizontal,16);
  [text setContentHuggingPriority:100 forOrientation:NSLayoutConstraintOrientationHorizontal];
  [(*button).widthAnchor constraintEqualToConstant:112].active=YES;
  [text.widthAnchor constraintEqualToConstant:304].active=YES;
  [row.widthAnchor constraintEqualToConstant:432].active=YES;
  row.toolTip=detail; return row;
}
- (void)start {
  self.item=[NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
  NSImage *mark=[[[NSImage alloc] initWithContentsOfFile:[NSBundle.mainBundle pathForResource:@"MenuBarIcon" ofType:@"png"]] autorelease];
  if(!mark) mark=[NSImage imageWithSystemSymbolName:@"cursorarrow" accessibilityDescription:@"Computer Use"];
  mark.size=NSMakeSize(18,18); mark.template=YES; self.item.button.image=mark;
  self.item.button.accessibilityLabel=@"Codewhale Computer Use";
  NSMenu *menu=[NSMenu new];
  menu.autoenablesItems=NO;
  NSMenuItem *show=[menu addItemWithTitle:@"Computer Use…" action:@selector(show:) keyEquivalent:@""]; show.target=self;
  self.previewItem=[menu addItemWithTitle:@"Close preview" action:@selector(dismissPreview:) keyEquivalent:@""];
  self.previewItem.target=NSApp.delegate; self.previewItem.enabled=NO;
  [menu addItem:NSMenuItem.separatorItem];
  self.pauseItem=[menu addItemWithTitle:@"Pause" action:@selector(pause:) keyEquivalent:@""]; self.pauseItem.target=self;
  self.stopItem=[menu addItemWithTitle:@"Stop computer use" action:@selector(stop:) keyEquivalent:@""]; self.stopItem.target=self;
  [menu addItem:NSMenuItem.separatorItem];
  NSMenuItem *quit=[menu addItemWithTitle:@"Quit Computer Use" action:@selector(terminate:) keyEquivalent:@""]; quit.target=NSApp;
  menu.delegate=self; self.item.menu=menu; cuControlBuffer=[NSMutableData new];
  [self buildWindow];
  if(cuControlFD>=0) {
    int fd=cuControlFD;
    cuControlReader=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,(uintptr_t)fd,0,dispatch_get_main_queue());
    dispatch_source_set_event_handler(cuControlReader,^{ [self drain]; });
    dispatch_source_set_cancel_handler(cuControlReader,^{ close(fd); });
    dispatch_resume(cuControlReader);
    cuControlWriter=dispatch_source_create(DISPATCH_SOURCE_TYPE_WRITE,(uintptr_t)fd,0,dispatch_get_main_queue());
    dispatch_source_set_event_handler(cuControlWriter,^{ cuFlushControl(); });
  }
  self.consent=[[CUConsentPanel new] autorelease];
  self.sessionPill=[[CUSessionPillController new] autorelease];
  cuSendJSON(cuTrustSnapshot());
  cuSendJSON(@{@"command":@"capabilities",@"consent":@1,@"hostTrust":@1});
  cuSend(@"status");
}
- (void)buildWindow {
  self.window=[[CUControlWindow alloc] initWithContentRect:NSMakeRect(0,0,480,260) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
  self.window.title=@"Computer Use"; self.window.releasedWhenClosed=NO; self.window.delegate=self;
  self.window.collectionBehavior=NSWindowCollectionBehaviorMoveToActiveSpace;
  NSImage *appIcon=[[[NSImage alloc] initWithContentsOfFile:[NSBundle.mainBundle pathForResource:@"AppIcon" ofType:@"icns"]] autorelease];
  if(!appIcon) appIcon=[NSImage imageNamed:NSImageNameApplicationIcon];
  NSImageView *icon=[NSImageView imageViewWithImage:appIcon];
  [icon.widthAnchor constraintEqualToConstant:32].active=YES; [icon.heightAnchor constraintEqualToConstant:32].active=YES;
  NSTextField *byline=cuLabel(@"By Codewhale",12,NSFontWeightRegular); byline.textColor=NSColor.secondaryLabelColor;
  NSStackView *head=cuStack(@[icon,cuStack(@[cuLabel(@"Computer Use",20,NSFontWeightSemibold),byline],NSUserInterfaceLayoutOrientationVertical,3)],NSUserInterfaceLayoutOrientationHorizontal,14);

  NSTextField *access; NSButton *accessButton;
  NSView *ax=[self permissionRow:@"Accessibility" detail:@"Lets your agent read app controls and interact with them." status:&access button:&accessButton action:@selector(openAccessibility:)]; self.accessStatus=access; self.accessButton=accessButton;
  NSTextField *screen; NSButton *screenButton;
  NSView *sc=[self permissionRow:@"Screen Recording" detail:@"Capture the selected app when the task needs an image." status:&screen button:&screenButton action:@selector(openScreen:)]; self.screenStatus=screen; self.screenButton=screenButton;
  self.checkButton=cuButton(@"Run background check",self,@selector(check:));
  self.checkResult=cuLabel(@"Uses a practice window to check background control. Available when no apps are connected.",12,NSFontWeightRegular);
  self.checkResult.textColor=NSColor.secondaryLabelColor;
  self.setupSection=cuStack(@[cuLabel(@"Mac permissions",15,NSFontWeightSemibold),ax,sc],NSUserInterfaceLayoutOrientationVertical,14);
  self.activity=cuLabel(@"Connecting to helper…",15,NSFontWeightSemibold);
  self.targets=cuLabel(@"Ask Codewhale to work in an app to begin.",13,NSFontWeightRegular); self.targets.textColor=NSColor.secondaryLabelColor;
  self.pauseButton=cuButton(@"Pause",self,@selector(pause:)); self.stopButton=cuButton(@"Stop computer use",self,@selector(stop:));
  self.stopButton.hasDestructiveAction=YES;
  self.activityButtons=cuStack(@[self.pauseButton,self.stopButton],NSUserInterfaceLayoutOrientationHorizontal,8);
  self.errorLabel=cuLabel(@"",12,NSFontWeightRegular); self.errorLabel.textColor=NSColor.systemRedColor;
  NSStackView *activity=cuStack(@[self.activity,self.targets,self.activityButtons,self.errorLabel],NSUserInterfaceLayoutOrientationVertical,10);
  self.hostRows=cuStack(@[],NSUserInterfaceLayoutOrientationVertical,12); self.hostRows.translatesAutoresizingMaskIntoConstraints=YES;
  NSScrollView *hostsScroll=[[[NSScrollView alloc] initWithFrame:NSMakeRect(0,0,432,40)] autorelease];
  self.hostsScroll=hostsScroll;
  hostsScroll.translatesAutoresizingMaskIntoConstraints=NO; hostsScroll.hasVerticalScroller=YES; hostsScroll.hasHorizontalScroller=NO; hostsScroll.autohidesScrollers=YES; hostsScroll.drawsBackground=NO;
  hostsScroll.documentView=self.hostRows;
  self.hostsHeight=[hostsScroll.heightAnchor constraintEqualToConstant:40]; self.hostsHeight.active=YES;
  [hostsScroll.widthAnchor constraintEqualToConstant:432].active=YES;
  self.trustError=cuLabel(@"",12,NSFontWeightRegular); self.trustError.textColor=NSColor.systemRedColor;
  NSTextField *trustDetail=cuLabel(@"Trust applies to this host across chats, models and apps. Turn it off to stop its access; turning it back on requires Touch ID or your Mac password.",12,NSFontWeightRegular); trustDetail.textColor=NSColor.secondaryLabelColor;
  self.historyButton=[NSButton checkboxWithTitle:@"Show connections with access turned off" target:self action:@selector(showHistory:)];
  NSStackView *hosts=cuStack(@[cuLabel(@"Trusted hosts",15,NSFontWeightSemibold),trustDetail,hostsScroll,self.historyButton],NSUserInterfaceLayoutOrientationVertical,10);
  NSString *version=[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"]?:@"";
  NSTextField *versionLabel=cuLabel([@"Version " stringByAppendingString:version],11,NSFontWeightRegular); versionLabel.textColor=NSColor.secondaryLabelColor;
  NSButton *help=cuButton(@"Help",self,@selector(help:)); self.updateButton=cuButton(@"Check for updates…",self,@selector(updates:));
  NSStackView *footer=cuStack(@[versionLabel,help,self.updateButton],NSUserInterfaceLayoutOrientationHorizontal,12);
  self.updateStatus=cuLabel(@"",12,NSFontWeightRegular); self.updateStatus.textColor=NSColor.secondaryLabelColor;
  NSStackView *updates=cuStack(@[footer,self.updateStatus],NSUserInterfaceLayoutOrientationVertical,8);
  self.settingsSection=cuStack(@[cuSeparator(),hosts,cuSeparator(),self.checkButton,self.checkResult,updates],NSUserInterfaceLayoutOrientationVertical,14);
  self.settingsSection.hidden=YES;
  self.settingsButton=cuButton(@"Settings…",self,@selector(settings:));
  NSButton *done=cuButton(@"Done",self,@selector(close:));
  NSStackView *navigation=cuStack(@[self.settingsButton,done],NSUserInterfaceLayoutOrientationHorizontal,8);
  NSStackView *body=cuStack(@[head,activity,self.trustError,self.setupSection,self.settingsSection,navigation],NSUserInterfaceLayoutOrientationVertical,20);
  self.body=body;
  body.detachesHiddenViews=YES;
  NSScrollView *scroll=[[[NSScrollView alloc] initWithFrame:self.window.contentView.bounds] autorelease];
  scroll.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable; scroll.borderType=NSNoBorder;
  scroll.drawsBackground=NO; scroll.hasVerticalScroller=YES; scroll.hasHorizontalScroller=NO; scroll.autohidesScrollers=YES; scroll.scrollerStyle=NSScrollerStyleOverlay;
  NSView *document=[[[CUControlDocumentView alloc] initWithFrame:self.window.contentView.bounds] autorelease];
  scroll.documentView=document; self.bodyScroll=scroll; self.bodyDocument=document;
  [self.window.contentView addSubview:scroll]; [document addSubview:body];
  [NSLayoutConstraint activateConstraints:@[[body.topAnchor constraintEqualToAnchor:document.topAnchor constant:24],[body.leadingAnchor constraintEqualToAnchor:document.leadingAnchor constant:24],[body.trailingAnchor constraintEqualToAnchor:document.trailingAnchor constant:-24],[body.bottomAnchor constraintLessThanOrEqualToAnchor:document.bottomAnchor constant:-24]]];
  for(NSView *view in body.arrangedSubviews) [view.widthAnchor constraintEqualToAnchor:body.widthAnchor].active=YES;
  for(NSView *view in @[self.targets,self.checkResult,self.errorLabel,self.updateStatus,trustDetail,self.trustError]) [view.widthAnchor constraintEqualToConstant:432].active=YES;
  [self renderHosts];
  [self.window center];
}
- (void)show:(id)sender {
  [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
  if(!self.timer) self.timer=[NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
  [self tick:nil];
}
- (void)settings:(id)sender {
  self.settingsVisible=!self.settingsVisible;
  self.settingsSection.hidden=!self.settingsVisible;
  self.settingsButton.title=self.settingsVisible?@"Hide settings":@"Settings…";
  [self tick:nil];
}
- (void)showHistory:(id)sender { self.renderedHosts=nil; [self renderHosts]; [self tick:nil]; }
- (void)close:(id)sender { [self.window close]; }
- (void)windowWillClose:(NSNotification *)notification { [self.timer invalidate]; self.timer=nil; [self.trustAuthContext invalidate]; self.trustAuthContext=nil; }
- (void)menuWillOpen:(NSMenu *)menu { cuSend(@"status"); }
- (void)openAccessibility:(id)sender {
  NSDictionary *options=@{(__bridge NSString *)kAXTrustedCheckOptionPrompt:@YES}; if(!AXIsProcessTrusted()) AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
}
- (void)openScreen:(id)sender {
  if(!CGPreflightScreenCaptureAccess()) CGRequestScreenCaptureAccess();
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]];
}
- (void)pause:(id)sender { cuSend([self.state[@"mode"] isEqual:@"ready"]?@"pause":@"resume"); }
- (void)stop:(id)sender { [self.trustAuthContext invalidate]; self.trustAuthContext=nil; cuSend(@"stop"); }
- (void)check:(id)sender { self.checkResult.stringValue=@"Checking the practice window…"; cuSend(@"check"); }
- (void)help:(id)sender { [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"https://github.com/codewhale-hq/codewhale-cu-plugin/blob/main/docs/TROUBLESHOOTING.md"]]; }
- (void)updates:(id)sender {
  if([self.state[@"update"] isKindOfClass:NSDictionary.class] && [self.state[@"update"][@"available"] boolValue]) cuSend(@"install_update");
  else cuSend(@"updates");
}
- (void)renderHosts {
  NSDictionary *snapshot=cuTrustSnapshot();
  BOOL showHistory=self.historyButton.state==NSControlStateValueOn;
  NSArray *records=[(cuHostTrustRecords?:@[]) filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *record, NSDictionary *bindings) { return showHistory || [record[@"decision"] isEqual:@"allow"]; }]];
  NSDictionary *viewState=@{@"snapshot":snapshot,@"records":records,@"authenticating":@(self.trustAuthContext!=nil),@"actionError":self.trustActionError?:@"",@"connected":@(cuControlFD>=0)};
  if([self.renderedHosts isEqual:viewState]) return;
  BOOL recordsChanged=![self.renderedHosts[@"records"] isEqual:records];
  self.renderedHosts=viewState;
  for(NSView *row in [[self.hostRows.arrangedSubviews copy] autorelease]) { [self.hostRows removeArrangedSubview:row]; [row removeFromSuperview]; }
  if(!records.count) {
    NSTextField *empty=cuLabel(@"No trusted hosts.\nYour agent will ask the first time it needs to use this Mac.",12,NSFontWeightRegular);
    [empty.widthAnchor constraintEqualToConstant:412].active=YES;
    [empty.heightAnchor constraintGreaterThanOrEqualToConstant:36].active=YES;
    [self.hostRows addArrangedSubview:empty];
  }
  for(NSDictionary *record in records) {
    NSString *key=record[@"publicKey"]; BOOL revoked=[record[@"decision"] isEqual:@"revoked"];
    NSString *status=snapshot[@"error"]?@"Access unavailable":revoked?@"Access off":@"Trusted until turned off";
    NSString *detail=[record[@"exclusions"] count]?[NSString stringWithFormat:@"%@ · %lu app exceptions",status,(unsigned long)[record[@"exclusions"] count]]:status;
    NSUInteger matches=0;
    for(NSDictionary *other in records) if([other[@"label"] isEqual:record[@"label"]]) matches++;
    if(matches>1) detail=[detail stringByAppendingFormat:@" · ID %@",[key substringWithRange:NSMakeRange(44,12)]];
    NSTextField *description=cuLabel(detail,11,NSFontWeightRegular); description.textColor=NSColor.secondaryLabelColor; description.toolTip=[@"Connection identity: " stringByAppendingString:key];
    NSStackView *text=cuStack(@[cuLabel(record[@"label"],13,NSFontWeightMedium),description],NSUserInterfaceLayoutOrientationVertical,3);
    [text.widthAnchor constraintEqualToConstant:360].active=YES;
    for(NSView *label in text.arrangedSubviews) [label.widthAnchor constraintEqualToAnchor:text.widthAnchor].active=YES;
    NSSwitch *button=[NSSwitch new]; button.target=self; button.action=@selector(toggleHost:);
    button.identifier=key; button.state=revoked?NSControlStateValueOff:NSControlStateValueOn;
    button.enabled=!snapshot[@"error"] && (self.trustAuthContext==nil || !revoked) && cuControlFD>=0;
    button.accessibilityLabel=[NSString stringWithFormat:@"Allow %@ to use this Mac",record[@"label"]];
    button.toolTip=revoked?@"Turn on access with Touch ID or your Mac password.":@"Turn off this host’s access immediately.";
    NSStackView *row=cuStack(@[text,button],NSUserInterfaceLayoutOrientationHorizontal,8); [row.widthAnchor constraintEqualToConstant:412].active=YES;
    if(!revoked && [record[@"exclusions"] count]) {
      NSButton *all=cuButton(@"Remove app restrictions…",self,@selector(allowHost:)); all.identifier=key; all.tag=1; all.enabled=self.trustAuthContext==nil && !snapshot[@"error"] && cuControlFD>=0;
      all.toolTip=@"Remove this host’s saved app and foreground exclusions after Touch ID or your Mac password.";
      all.accessibilityLabel=[NSString stringWithFormat:@"Allow all apps for %@, key %@, removing app and foreground exclusions",record[@"label"],[key substringWithRange:NSMakeRange(44,12)]];
      [self.hostRows addArrangedSubview:cuStack(@[row,all],NSUserInterfaceLayoutOrientationVertical,6)];
    } else [self.hostRows addArrangedSubview:row];
  }
  self.trustError.stringValue=snapshot[@"error"]?:self.trustActionError?:@""; self.trustError.hidden=self.trustError.stringValue.length==0;
  [self.hostRows layoutSubtreeIfNeeded];
  CGFloat height=MAX(24,self.hostRows.fittingSize.height);
  self.hostRows.frame=NSMakeRect(0,0,412,height); self.hostsHeight.constant=MIN(180,height);
  if(recordsChanged) {
    [self.hostsScroll.contentView scrollToPoint:NSMakePoint(0,MAX(0,height-self.hostsHeight.constant))];
    [self.hostsScroll reflectScrolledClipView:self.hostsScroll.contentView];
  }
}
- (void)toggleHost:(NSSwitch *)sender {
  BOOL enabling=sender.state==NSControlStateValueOn;
  sender.state=enabling?NSControlStateValueOff:NSControlStateValueOn;
  if(enabling) [self allowHost:sender]; else [self revokeHost:sender];
}
- (void)revokeHost:(NSControl *)sender {
  [self.trustAuthContext invalidate]; self.trustAuthContext=nil; self.trustActionError=nil;
  if(cuHostTrustPublicKey(sender.identifier)) {
    cuSendJSON(@{@"command":@"revoke_host",@"publicKey":sender.identifier});
    if(cuControlFD>=0 && cuControlOutput.length) shutdown(cuControlFD,SHUT_RDWR);
  }
  cuRevokeHost(sender.identifier); cuSendJSON(cuTrustSnapshot()); cuSend(@"status"); [self renderHosts];
}
- (void)allowHost:(NSControl *)sender {
  if(self.trustAuthContext) return;
  BOOL clearExclusions=sender.tag==1;
  NSDictionary *selected=nil;
  for(NSDictionary *record in cuHostTrustRecords) if([record[@"publicKey"] isEqual:sender.identifier] && (clearExclusions?([record[@"decision"] isEqual:@"allow"] && [record[@"exclusions"] count]>0):[record[@"decision"] isEqual:@"revoked"])) { selected=record; break; }
  if(!selected) return;
  self.trustActionError=nil;
  NSDictionary *host=[@{@"publicKey":selected[@"publicKey"],@"label":selected[@"label"],@"persistent":@YES} retain];
  LAContext *context=[LAContext new]; self.trustAuthContext=context; context.localizedFallbackTitle=@"Use Password";
  [self renderHosts];
  NSString *reason=clearExclusions?@"remove this host’s saved app and foreground exclusions, allowing it to operate any app until you revoke trust":@"trust this Computer Use host until you revoke it";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:reason reply:^(BOOL success,NSError *error) {
    dispatch_async(dispatch_get_main_queue(),^{
      if(self.trustAuthContext!=context) { [host release]; [context release]; return; }
      self.trustAuthContext=nil;
      if(success) { if(clearExclusions) cuClearHostExclusions(host[@"publicKey"]); else cuTrustHost(host); cuSendJSON(cuTrustSnapshot()); cuSend(@"status"); }
      else self.trustActionError=@"Nothing was approved. Changing host access requires Touch ID or your Mac password.";
      [self renderHosts]; [host release]; [context release];
    });
  }];
}
- (void)render:(NSDictionary *)state {
  self.state=state;
  [self.consent handle:state[@"consent"]];
  [self.sessionPill updateWithState:state controlTarget:self];
  [self renderHosts];
  NSString *mode=state[@"mode"]?:@"stopped"; BOOL ready=[mode isEqual:@"ready"], pending=[state[@"cleanupPending"] boolValue];
  NSArray *sessions=state[@"sessions"]?:@[];
  BOOL foreground=NO, running=NO; NSMutableArray *lines=[NSMutableArray new];
  for(NSDictionary *session in sessions) {
    BOOL shared=[session[@"mode"] isEqual:@"foreground"]; foreground|=shared; running|=[session[@"action"] isKindOfClass:NSString.class];
    if(lines.count<4) [lines addObject:[NSString stringWithFormat:@"%@ · %@",session[@"target"][@"name"]?:@"Application",shared?@"Foreground":@"Background"]];
  }
  if(sessions.count>4) [lines addObject:[NSString stringWithFormat:@"And %lu more sessions",(unsigned long)sessions.count-4]];
  BOOL setupRequired=!AXIsProcessTrusted() || !CGPreflightScreenCaptureAccess(), waiting=[state[@"consent"] isKindOfClass:NSDictionary.class];
  self.activity.stringValue=setupRequired?@"Finish setting up this Mac":pending?@"Stopping computer use…":!ready?([mode isEqual:@"paused"]?@"Computer use is paused":@"Computer use is stopped"):waiting?@"Waiting for your approval":running?@"Working in your apps":sessions.count?@"Connected to your apps":@"Ready";
  self.targets.stringValue=setupRequired?@"Allow the missing Mac permissions below, then return to your task.":waiting?@"Review the Computer Use request. Only allow it if you asked your agent to do this.":lines.count?[lines componentsJoinedByString:@"\n"]:!ready?@"Your agent cannot use this Mac. Resume when you are ready.":@"Ask your agent to work in an app. You can stop computer use from the menu bar.";
  self.targets.textColor=foreground?NSColor.systemOrangeColor:NSColor.secondaryLabelColor;
  NSString *pauseTitle=ready?@"Pause":@"Resume computer use";
  self.pauseButton.title=pauseTitle; self.pauseItem.title=pauseTitle;
  self.activityButtons.hidden=ready && sessions.count==0 && !pending && !waiting;
  self.pauseButton.enabled=!pending; self.pauseItem.enabled=!pending && (!ready || sessions.count>0 || waiting);
  self.stopButton.enabled=![mode isEqual:@"stopped"] && !pending && (sessions.count>0 || waiting); self.stopItem.enabled=self.stopButton.enabled;
  self.item.button.toolTip=[NSString stringWithFormat:@"Computer Use — %@",self.activity.stringValue];
  BOOL checking=[state[@"checking"] boolValue];
  self.checkButton.title=checking?@"Checking…":@"Run background check";
  self.checkButton.enabled=AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() && ready && !checking && !pending && !waiting && sessions.count==0;
  if([state[@"backgroundCheck"] isKindOfClass:NSDictionary.class]) self.checkResult.stringValue=state[@"backgroundCheck"][@"message"]?:@"Check finished.";
  self.errorLabel.stringValue=[state[@"error"] isKindOfClass:NSString.class]?state[@"error"]:@"";
  self.errorLabel.hidden=self.errorLabel.stringValue.length==0;
  if(pending && self.errorLabel.stringValue.length) {
    self.activity.stringValue=@"Computer input is blocked";
    self.errorLabel.stringValue=[self.errorLabel.stringValue stringByAppendingString:@" Quit and reopen Computer Use after checking permissions."];
  }
  self.updateStatus.stringValue=@"";
  if([state[@"update"] isKindOfClass:NSDictionary.class]) {
    self.updateStatus.stringValue=state[@"update"][@"message"]?:@"";
    self.updateButton.enabled=![state[@"update"][@"busy"] boolValue];
    self.updateButton.title=[state[@"update"][@"available"] boolValue]?[NSString stringWithFormat:@"Install %@…",state[@"update"][@"version"]]:@"Check for updates…";
  }
  self.updateStatus.hidden=self.updateStatus.stringValue.length==0;
  [self.bodyDocument layoutSubtreeIfNeeded];
  CGFloat height=MAX(240,self.body.fittingSize.height+48);
  NSScreen *screen=self.window.screen?:NSScreen.mainScreen?:NSScreen.screens.firstObject;
  NSRect visible=screen?screen.visibleFrame:NSZeroRect;
  CGFloat chrome=NSHeight([self.window frameRectForContentRect:NSMakeRect(0,0,480,height)])-height;
  CGFloat windowHeight=screen?MIN(height,MAX(1,NSHeight(visible)-chrome)):height;
  if(fabs(windowHeight-self.window.contentView.bounds.size.height)>1) [self.window setContentSize:NSMakeSize(480,windowHeight)];
  [self.bodyDocument setFrameSize:NSMakeSize(480,MAX(height,self.bodyScroll.contentSize.height))];
  if(screen) {
    NSRect frame=self.window.frame;
    NSPoint origin=NSMakePoint(MAX(NSMinX(visible),MIN(NSMinX(frame),NSMaxX(visible)-NSWidth(frame))),MAX(NSMinY(visible),MIN(NSMinY(frame),NSMaxY(visible)-NSHeight(frame))));
    if(!NSEqualPoints(origin,frame.origin)) [self.window setFrameOrigin:origin];
  }
}
- (void)tick:(NSTimer *)timer {
  BOOL ax=AXIsProcessTrusted(), sc=CGPreflightScreenCaptureAccess();
  self.setupSection.hidden=ax && sc && !self.settingsVisible;
  self.accessStatus.stringValue=ax?@"Granted · read controls and send input":@"Required to read controls and send input";
  self.screenStatus.stringValue=sc?@"Granted · capture app windows":@"Required for screenshots. If missing in Settings, add Computer Use with +.";
  self.accessButton.title=ax?@"Settings…":@"Allow…"; self.screenButton.title=sc?@"Settings…":@"Allow…";
  cuSend(@"status");
}
- (void)drain {
  if(cuControlFD<0) return;
  char bytes[4096]; ssize_t count;
  while((count=read(cuControlFD,bytes,sizeof bytes))>0) [cuControlBuffer appendBytes:bytes length:(NSUInteger)count];
  if(count==0) { cuControlFD=-1; if(cuControlWriter) { if(cuControlWriterSuspended) { cuControlWriterSuspended=NO; dispatch_resume(cuControlWriter); } dispatch_source_cancel(cuControlWriter); cuControlWriter=NULL; } dispatch_source_cancel(cuControlReader); [self.trustAuthContext invalidate]; self.trustAuthContext=nil; [self.consent withdraw]; [self.sessionPill invalidate]; self.activity.stringValue=@"Helper disconnected"; self.targets.stringValue=@"Quit and reopen Computer Use to reconnect."; self.pauseButton.enabled=NO; self.stopButton.enabled=NO; self.checkButton.enabled=NO; self.pauseItem.enabled=NO; self.stopItem.enabled=NO; self.updateButton.enabled=NO; [self renderHosts]; return; }
  if(cuControlBuffer.length>262144) { [cuControlBuffer setLength:0]; shutdown(cuControlFD,SHUT_RDWR); return; }
  while(YES) {
    const char *start=cuControlBuffer.bytes; const char *end=memchr(start,'\n',cuControlBuffer.length); if(!end) break;
    NSUInteger length=(NSUInteger)(end-start); NSData *line=[NSData dataWithBytes:start length:length];
    if(length>=65536) { [cuControlBuffer setLength:0]; shutdown(cuControlFD,SHUT_RDWR); return; }
    [cuControlBuffer replaceBytesInRange:NSMakeRange(0,length+1) withBytes:NULL length:0];
    NSDictionary *state=[NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
    if([state isKindOfClass:NSDictionary.class]) {
      if(state[@"host_exclusion"]) {
        id exclusion=state[@"host_exclusion"];
        if([exclusion isKindOfClass:NSDictionary.class]) cuHostExclusions(exclusion[@"publicKey"],exclusion[@"keys"]);
        else cuHostTrustFail(@"Computer Use refused invalid excluded apps.",errSecSuccess);
        cuSendJSON(cuTrustSnapshot()); cuSend(@"status"); [self renderHosts];
      } else [self render:state];
    }
  }
}
@end
