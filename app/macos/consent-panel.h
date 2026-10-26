// The approval panel: the one place a person can allow Computer Use to operate
// an app. It is drawn by this signed helper and answered only here. The daemon
// pushes a prompt over the inherited control socketpair (the same channel that
// already carries Pause and Stop; it has no filesystem endpoint and no MCP
// equivalent) and accepts one decision back for that prompt id. Allow needs the
// person to be present: LocalAuthentication (Touch ID or the login password),
// whose prompt a system process draws, so a click or keystroke synthesized by
// another program cannot answer it. Deny needs nothing. A Mac that cannot
// evaluate the policy (no password, no biometrics) refuses every approval.
#import <LocalAuthentication/LocalAuthentication.h>

static NSString *cuConsentClean(id value, NSUInteger limit) {
  if(![value isKindOfClass:NSString.class]) return @"";
  NSMutableString *text=[NSMutableString stringWithCapacity:MIN(limit+1,[(NSString *)value length])];
  [(NSString *)value enumerateSubstringsInRange:NSMakeRange(0,[(NSString *)value length]) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString *piece,NSRange range,NSRange enclosing,BOOL *stop) {
    if(text.length>=limit) { *stop=YES; return; }
    unichar first=[piece characterAtIndex:0];
    NSCharacterSet *bad=NSCharacterSet.controlCharacterSet;
    if([bad characterIsMember:first] || (first>=0x200B && first<=0x200F) || (first>=0x202A && first<=0x202E) || (first>=0x2066 && first<=0x2069) || first==0xFEFF || first==0x2028 || first==0x2029) [text appendString:@" "];
    else [text appendString:piece];
  }];
  NSString *trimmed=[text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return trimmed.length>limit?[trimmed substringToIndex:limit]:trimmed;
}

@interface CUConsentPanel : NSObject <NSWindowDelegate>
@property(retain) NSPanel *panel;
@property(copy) NSString *promptID;
@property(retain) NSDate *expires;
@property(copy) NSString *reason;
@property(retain) NSTimer *timer;
@property(retain) NSTextField *countdown;
@property(retain) NSTextField *authNote;
@property(retain) NSButton *denyButton;
@property(retain) NSButton *allowButton;
@property(assign) BOOL authenticating;
@property(assign) BOOL answered;
@property(assign) BOOL ownsClose;
- (void)handle:(id)prompt;
@end

@implementation CUConsentPanel
- (BOOL)usable:(NSDictionary *)prompt {
  NSString *identifier=prompt[@"id"];
  if(![identifier isKindOfClass:NSString.class] || identifier.length<8 || identifier.length>64) return NO;
  NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  if([identifier rangeOfCharacterFromSet:allowed.invertedSet].location!=NSNotFound) return NO;
  if(![prompt[@"expiresAt"] isKindOfClass:NSNumber.class]) return NO;
  double remaining=[prompt[@"expiresAt"] doubleValue]/1000.0-[NSDate date].timeIntervalSince1970;
  if(remaining<=0 || remaining>600) return NO;
  return [prompt[@"headline"] isKindOfClass:NSString.class] && cuConsentClean(prompt[@"headline"],240).length>0;
}
- (void)handle:(id)prompt {
  if(![prompt isKindOfClass:NSDictionary.class]) { [self withdraw]; return; }
  NSDictionary *request=prompt;
  if(![self usable:request]) return;
  if([request[@"id"] isEqual:self.promptID]) return;
  if(self.panel && !self.answered) [self finish:@"deny" auth:@"none"];
  [self present:request];
}
- (void)withdraw {
  if(!self.panel) return;
  self.answered=YES;
  [self closePanel];
}
- (void)present:(NSDictionary *)prompt {
  self.promptID=prompt[@"id"];
  self.answered=NO; self.authenticating=NO;
  self.expires=[NSDate dateWithTimeIntervalSince1970:[prompt[@"expiresAt"] doubleValue]/1000.0];
  NSString *headline=cuConsentClean(prompt[@"headline"],240);
  NSString *reason=cuConsentClean(prompt[@"reason"],90);
  self.reason=reason.length?reason:@"approve this Computer Use request";
  NSMutableArray *rows=[NSMutableArray new];
  NSArray *lines=[prompt[@"lines"] isKindOfClass:NSArray.class]?prompt[@"lines"]:@[];
  for(id line in lines) { if(rows.count>=8) break; NSString *clean=cuConsentClean(line,240); if(clean.length) [rows addObject:clean]; }
  LAContext *probe=[[LAContext new] autorelease]; NSError *unavailable=nil;
  BOOL canAuthenticate=[probe canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&unavailable];

  NSTextField *title=cuLabel(@"Computer Use needs your approval",15,NSFontWeightSemibold);
  NSTextField *head=cuLabel(headline,13,NSFontWeightSemibold);
  NSTextField *details=cuLabel([rows componentsJoinedByString:@"\n"],12,NSFontWeightRegular); details.textColor=NSColor.secondaryLabelColor;
  details.hidden=rows.count==0;
  NSTextField *note=cuLabel(@"Allow only if you asked for this. Deny, Escape, closing this window or no answer refuses it.",12,NSFontWeightRegular); note.textColor=NSColor.secondaryLabelColor;
  self.authNote=cuLabel(canAuthenticate?@"Allowing asks for Touch ID or your Mac password, so only you can approve it.":@"This Mac has no password or Touch ID set up, so Computer Use approvals are refused. Set a password in System Settings, then try again.",12,NSFontWeightRegular);
  self.authNote.textColor=canAuthenticate?NSColor.secondaryLabelColor:NSColor.systemRedColor;
  self.countdown=cuLabel(@"",11,NSFontWeightRegular); self.countdown.textColor=NSColor.secondaryLabelColor;
  self.denyButton=cuButton(@"Deny",self,@selector(deny:)); self.denyButton.keyEquivalent=@"\r";
  self.denyButton.accessibilityLabel=@"Deny this request";
  self.allowButton=cuButton(@"Allow…",self,@selector(allow:)); self.allowButton.enabled=canAuthenticate;
  self.allowButton.accessibilityLabel=@"Allow this request, after Touch ID or your password";
  NSStackView *buttons=cuStack(@[self.denyButton,self.allowButton],NSUserInterfaceLayoutOrientationHorizontal,8);
  NSStackView *body=cuStack(@[title,head,details,cuSeparator(),note,self.authNote,self.countdown,buttons],NSUserInterfaceLayoutOrientationVertical,10);
  if(!self.panel) {
    self.panel=[[[NSPanel alloc] initWithContentRect:NSMakeRect(0,0,460,300) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO] autorelease];
    self.panel.releasedWhenClosed=NO; self.panel.delegate=self; self.panel.hidesOnDeactivate=NO;
    self.panel.level=NSFloatingWindowLevel; self.panel.title=@"Computer Use";
    self.panel.collectionBehavior=NSWindowCollectionBehaviorMoveToActiveSpace|NSWindowCollectionBehaviorFullScreenAuxiliary;
  }
  for(NSView *old in [[self.panel.contentView.subviews copy] autorelease]) [old removeFromSuperview];
  [self.panel.contentView addSubview:body];
  [NSLayoutConstraint activateConstraints:@[[body.topAnchor constraintEqualToAnchor:self.panel.contentView.topAnchor constant:20],[body.leadingAnchor constraintEqualToAnchor:self.panel.contentView.leadingAnchor constant:20],[body.trailingAnchor constraintEqualToAnchor:self.panel.contentView.trailingAnchor constant:-20],[body.bottomAnchor constraintLessThanOrEqualToAnchor:self.panel.contentView.bottomAnchor constant:-20]]];
  for(NSView *view in @[head,details,note,self.authNote]) [view.widthAnchor constraintEqualToConstant:420].active=YES;
  [self.panel.contentView layoutSubtreeIfNeeded];
  [self.panel setContentSize:NSMakeSize(460,body.fittingSize.height+40)];
  [self.panel center];
  self.panel.initialFirstResponder=self.denyButton;
  [self.timer invalidate];
  self.timer=[NSTimer scheduledTimerWithTimeInterval:0.5 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
  [self tick:nil];
  [self.panel makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
  [self.panel makeFirstResponder:self.denyButton];
  NSAccessibilityPostNotificationWithUserInfo(self.panel,NSAccessibilityAnnouncementRequestedNotification,@{NSAccessibilityAnnouncementKey:[@"Computer Use needs your approval. " stringByAppendingString:headline],NSAccessibilityPriorityKey:@(NSAccessibilityPriorityHigh)});
}
- (void)tick:(NSTimer *)timer {
  NSTimeInterval remaining=[self.expires timeIntervalSinceNow];
  if(remaining<=0) { if(!self.answered && !self.authenticating) [self finish:@"deny" auth:@"none"]; return; }
  NSInteger seconds=(NSInteger)ceil(remaining);
  self.countdown.stringValue=[NSString stringWithFormat:@"Refused automatically in %ld:%02ld",(long)(seconds/60),(long)(seconds%60)];
}
- (void)deny:(id)sender { if(!self.authenticating) [self finish:@"deny" auth:@"none"]; }
- (void)cancelOperation:(id)sender { if(!self.authenticating) [self finish:@"deny" auth:@"none"]; }
- (BOOL)windowShouldClose:(NSWindow *)sender { if(!self.answered && !self.authenticating) [self finish:@"deny" auth:@"none"]; return self.answered; }
- (void)allow:(id)sender {
  if(self.answered || self.authenticating || !self.allowButton.enabled) return;
  self.authenticating=YES; self.allowButton.enabled=NO; self.denyButton.enabled=NO;
  NSString *prompt=[self.promptID copy];
  LAContext *context=[LAContext new];
  context.localizedFallbackTitle=@"Use Password";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:self.reason reply:^(BOOL success,NSError *error) {
    dispatch_async(dispatch_get_main_queue(),^{
      self.authenticating=NO;
      if(![prompt isEqualToString:self.promptID] || self.answered) { [prompt release]; [context release]; return; }
      if(success && [self.expires timeIntervalSinceNow]>0) [self finish:@"allow" auth:@"local"];
      else if(!success && (error.code==LAErrorUserCancel || error.code==LAErrorSystemCancel || error.code==LAErrorAppCancel)) {
        self.denyButton.enabled=YES; self.allowButton.enabled=YES;
        self.authNote.stringValue=@"Nothing was approved. Press Allow to try again, or Deny.";
      } else [self finish:@"deny" auth:success?@"expired":@"failed"];
      [prompt release]; [context release];
    });
  }];
}
- (void)finish:(NSString *)decision auth:(NSString *)auth {
  if(self.answered) return;
  self.answered=YES;
  NSString *identifier=self.promptID?:@"";
  cuSendJSON(@{@"command":@"consent_decision",@"consent":identifier,@"decision":decision,@"auth":auth});
  [self closePanel];
}
- (void)closePanel {
  [self.timer invalidate]; self.timer=nil;
  self.ownsClose=YES; [self.panel orderOut:nil]; self.ownsClose=NO;
}
@end
