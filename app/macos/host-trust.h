#import <Security/Security.h>

static NSArray *cuHostTrustRecords;
static NSString *cuHostTrustError;
static BOOL cuHostTrustLoaded=NO, cuHostTrustReady=NO;
static SecKeychainRef cuHostTrustKeychain=NULL;
static SecKeychainItemRef cuHostTrustItem=NULL;

static BOOL cuHostTrustFail(NSString *message, OSStatus status) {
  CFStringRef detail=status==errSecSuccess?NULL:SecCopyErrorMessageString(status,NULL);
  NSString *text=detail?[NSString stringWithFormat:@"%@ %@",message,(NSString *)detail]:message;
  [cuHostTrustError release]; cuHostTrustError=[text copy];
  if(detail) CFRelease(detail);
  return NO;
}

static BOOL cuHostTrustPublicKey(id value) {
  if(![value isKindOfClass:NSString.class] || [value length]!=60) return NO;
  NSData *data=[[[NSData alloc] initWithBase64EncodedString:value options:0] autorelease];
  const unsigned char prefix[]={0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
  return data.length==44 && memcmp(data.bytes,prefix,sizeof prefix)==0 && [[data base64EncodedStringWithOptions:0] isEqual:value];
}

static NSCharacterSet *cuHostTrustUnsafeCharacters(void) {
  NSMutableCharacterSet *characters=[[NSCharacterSet.controlCharacterSet mutableCopy] autorelease];
  [characters addCharactersInRange:NSMakeRange(0x200b,5)];
  [characters addCharactersInRange:NSMakeRange(0x2028,7)];
  [characters addCharactersInRange:NSMakeRange(0x2066,4)];
  [characters addCharactersInString:@"\ufeff"];
  return characters;
}

static NSString *cuHostTrustLabel(id value) {
  if(![value isKindOfClass:NSString.class]) return @"Connected host";
  NSString *clean=[[[value componentsSeparatedByCharactersInSet:cuHostTrustUnsafeCharacters()] componentsJoinedByString:@" "] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if(clean.length>80) clean=[clean substringToIndex:[clean rangeOfComposedCharacterSequenceAtIndex:80].location];
  return clean.length?clean:@"Connected host";
}

static BOOL cuHostTrustExclusion(id value) {
  if(![value isKindOfClass:NSString.class] || ![value length] || [value lengthOfBytesUsingEncoding:NSUTF32LittleEndianStringEncoding]/4>240) return NO;
  if([value rangeOfCharacterFromSet:cuHostTrustUnsafeCharacters()].location!=NSNotFound || ![value isEqual:[value lowercaseString]]) return NO;
  if([value isEqual:@"scope:foreground"]) return YES;
  if([value hasPrefix:@"name:"]) return [[value substringFromIndex:5] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length>0;
  if(![value hasPrefix:@"bundle:"] || [value length]<=7) return NO;
  NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789._-"];
  return [[value substringFromIndex:7] rangeOfCharacterFromSet:allowed.invertedSet].location==NSNotFound;
}

static BOOL cuHostTrustValidRecords(id records) {
  if(![records isKindOfClass:NSArray.class] || [records count]>32) return NO;
  NSMutableSet *seen=[NSMutableSet set];
  for(id record in records) {
    if(![record isKindOfClass:NSDictionary.class] || [record count]!=4 || !cuHostTrustPublicKey(record[@"publicKey"]) || [seen containsObject:record[@"publicKey"]]) return NO;
    if(![record[@"label"] isKindOfClass:NSString.class] || ![record[@"label"] isEqual:cuHostTrustLabel(record[@"label"])]) return NO;
    if(![record[@"decision"] isEqual:@"allow"] && ![record[@"decision"] isEqual:@"revoked"]) return NO;
    NSArray *keys=record[@"exclusions"];
    if(![keys isKindOfClass:NSArray.class] || keys.count>128 || [NSSet setWithArray:keys].count!=keys.count) return NO;
    for(id key in keys) if(!cuHostTrustExclusion(key)) return NO;
    [seen addObject:record[@"publicKey"]];
  }
  return YES;
}

static NSDictionary *cuHostTrustQuery(void) {
  return @{(id)kSecClass:(id)kSecClassGenericPassword,(id)kSecAttrService:@"net.codewhale.computer-use.host-trust",(id)kSecAttrAccount:@"hosts-v1",(id)kSecMatchSearchList:@[(id)cuHostTrustKeychain]};
}

static BOOL cuHostTrustLoad(BOOL retry) {
  if(cuHostTrustLoaded && !retry) return cuHostTrustReady;
  cuHostTrustLoaded=YES; cuHostTrustReady=NO;
  if(cuHostTrustItem) { CFRelease(cuHostTrustItem); cuHostTrustItem=NULL; }
  if(cuHostTrustKeychain) { CFRelease(cuHostTrustKeychain); cuHostTrustKeychain=NULL; }
  Boolean interaction=TRUE;
  OSStatus status=SecKeychainGetUserInteractionAllowed(&interaction);
  if(status!=errSecSuccess) return cuHostTrustFail(@"Computer Use could not read Keychain settings.",status);
  status=SecKeychainSetUserInteractionAllowed(false);
  if(status!=errSecSuccess) return cuHostTrustFail(@"Computer Use could not read trust quietly.",status);
  status=SecKeychainCopyDefault(&cuHostTrustKeychain);
  CFTypeRef result=NULL, value=NULL;
  if(status==errSecSuccess && cuHostTrustKeychain) {
    NSMutableDictionary *query=[[cuHostTrustQuery() mutableCopy] autorelease];
    query[(id)kSecReturnRef]=@YES; query[(id)kSecMatchLimit]=(id)kSecMatchLimitAll;
    status=SecItemCopyMatching((CFDictionaryRef)query,&result);
    if(status==errSecSuccess && result && CFGetTypeID(result)==CFArrayGetTypeID() && CFArrayGetCount((CFArrayRef)result)==1) {
      CFTypeRef item=CFArrayGetValueAtIndex((CFArrayRef)result,0);
      if(CFGetTypeID(item)==SecKeychainItemGetTypeID()) status=SecItemCopyMatching((CFDictionaryRef)@{(id)kSecClass:(id)kSecClassGenericPassword,(id)kSecMatchItemList:@[(id)item],(id)kSecReturnData:@YES,(id)kSecMatchLimit:(id)kSecMatchLimitOne},&value);
    }
  } else if(status==errSecSuccess) status=errSecNoDefaultKeychain;
  OSStatus restored=SecKeychainSetUserInteractionAllowed(interaction);
  if(restored!=errSecSuccess) { if(result) CFRelease(result); if(value) CFRelease(value); return cuHostTrustFail(@"Computer Use could not restore Keychain settings.",restored); }
  NSArray *records=@[];
  if(status==errSecSuccess) {
    NSArray *matches=(NSArray *)result;
    if(![matches isKindOfClass:NSArray.class] || matches.count!=1 || CFGetTypeID((CFTypeRef)matches[0])!=SecKeychainItemGetTypeID()) { if(result) CFRelease(result); if(value) CFRelease(value); return cuHostTrustFail(@"Saved Computer Use trust is ambiguous. No hosts are trusted.",errSecSuccess); }
    NSData *data=(NSData *)value;
    id ledger=[data isKindOfClass:NSData.class] && data.length<=49152?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
    id item=matches[0];
    if(![ledger isKindOfClass:NSDictionary.class] || [ledger count]!=2 || ![ledger[@"version"] isEqual:@1] || !cuHostTrustValidRecords(ledger[@"hosts"])) { CFRelease(result); if(value) CFRelease(value); return cuHostTrustFail(@"Saved Computer Use trust is invalid. No hosts are trusted.",errSecSuccess); }
    records=ledger[@"hosts"]; cuHostTrustItem=(SecKeychainItemRef)CFRetain((CFTypeRef)item);
  } else if(status!=errSecItemNotFound) {
    if(result) CFRelease(result); if(value) CFRelease(value);
    return cuHostTrustFail(@"Computer Use trust is unavailable. Unlock your login Keychain and try again.",status);
  }
  [cuHostTrustRecords release]; cuHostTrustRecords=[records copy];
  if(result) CFRelease(result); if(value) CFRelease(value);
  [cuHostTrustError release]; cuHostTrustError=nil; cuHostTrustReady=YES;
  return YES;
}

static BOOL cuHostTrustSave(NSArray *records) {
  if(!cuHostTrustValidRecords(records)) return cuHostTrustFail(@"Computer Use refused invalid trust data.",errSecSuccess);
  NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"version":@1,@"hosts":records} options:NSJSONWritingSortedKeys error:nil];
  if(!data || data.length>49152) return cuHostTrustFail(@"Computer Use trust storage is full. This change was not saved.",errSecSuccess);
  Boolean interaction=TRUE;
  OSStatus status=SecKeychainGetUserInteractionAllowed(&interaction);
  if(status!=errSecSuccess) return cuHostTrustFail(@"Computer Use could not read Keychain settings.",status);
  status=SecKeychainSetUserInteractionAllowed(false);
  if(status!=errSecSuccess) return cuHostTrustFail(@"Computer Use could not save trust quietly.",status);
  CFTypeRef result=NULL;
  if(cuHostTrustItem) {
    status=SecItemUpdate((CFDictionaryRef)@{(id)kSecClass:(id)kSecClassGenericPassword,(id)kSecMatchItemList:@[(id)cuHostTrustItem]},(CFDictionaryRef)@{(id)kSecValueData:data});
  } else {
    SecTrustedApplicationRef helper=NULL; SecAccessRef access=NULL;
    status=SecTrustedApplicationCreateFromPath(NULL,&helper);
    if(status==errSecSuccess) status=SecAccessCreate(CFSTR("Codewhale Computer Use trusted hosts"),(CFArrayRef)@[(id)helper],&access);
    if(status==errSecSuccess) {
      CFArrayRef encryption=SecAccessCopyMatchingACLList(access,kSecACLAuthorizationEncrypt);
      if(!encryption || CFArrayGetCount(encryption)!=1) status=errSecInvalidACL;
      else status=SecACLSetContents((SecACLRef)CFArrayGetValueAtIndex(encryption,0),(CFArrayRef)@[(id)helper],CFSTR("Codewhale Computer Use trusted hosts"),kSecKeychainPromptRequirePassphase);
      if(encryption) CFRelease(encryption);
    }
    if(status==errSecSuccess) {
      NSMutableDictionary *query=[[cuHostTrustQuery() mutableCopy] autorelease];
      [query removeObjectForKey:(id)kSecMatchSearchList];
      query[(id)kSecUseKeychain]=(id)cuHostTrustKeychain; query[(id)kSecAttrAccess]=(id)access;
      query[(id)kSecValueData]=data; query[(id)kSecAttrLabel]=@"Codewhale Computer Use trusted hosts"; query[(id)kSecReturnRef]=@YES;
      status=SecItemAdd((CFDictionaryRef)query,&result);
    }
    if(access) CFRelease(access); if(helper) CFRelease(helper);
  }
  OSStatus restored=SecKeychainSetUserInteractionAllowed(interaction);
  if(status==errSecSuccess && restored!=errSecSuccess) status=restored;
  if(status!=errSecSuccess) {
    if(result) CFRelease(result); cuHostTrustReady=NO;
    return cuHostTrustFail(@"Trust changes were not saved. No hosts are enabled; restarting may restore previous trust. Unlock your login Keychain and retry.",status);
  }
  if(result) { if(cuHostTrustItem) CFRelease(cuHostTrustItem); cuHostTrustItem=(SecKeychainItemRef)result; }
  [cuHostTrustRecords release]; cuHostTrustRecords=[records copy];
  [cuHostTrustError release]; cuHostTrustError=nil; cuHostTrustReady=YES;
  return YES;
}

static NSDictionary *cuTrustSnapshot(void) {
  cuHostTrustLoad(NO);
  NSMutableDictionary *snapshot=[NSMutableDictionary dictionaryWithDictionary:@{@"command":@"host_trust_state",@"hosts":cuHostTrustReady && !cuHostTrustError?cuHostTrustRecords:@[]}];
  if(cuHostTrustError) snapshot[@"error"]=cuHostTrustError;
  return snapshot;
}

static BOOL cuTrustHost(NSDictionary *host) {
  if(![host isKindOfClass:NSDictionary.class] || ![host[@"persistent"] isKindOfClass:NSNumber.class] || ![host[@"persistent"] boolValue] || !cuHostTrustPublicKey(host[@"publicKey"])) return cuHostTrustFail(@"This host cannot be trusted persistently.",errSecSuccess);
  if(!cuHostTrustLoad(!cuHostTrustReady)) return NO;
  NSMutableArray *records=[[cuHostTrustRecords mutableCopy] autorelease];
  NSUInteger index=[records indexOfObjectPassingTest:^BOOL(NSDictionary *record,NSUInteger i,BOOL *stop) { return [record[@"publicKey"] isEqual:host[@"publicKey"]]; }];
  NSArray *exclusions=index==NSNotFound?([host[@"exclusions"] isKindOfClass:NSArray.class]?host[@"exclusions"]:@[]):records[index][@"exclusions"];
  NSDictionary *record=@{@"publicKey":host[@"publicKey"],@"label":cuHostTrustLabel(host[@"label"]),@"decision":@"allow",@"exclusions":exclusions};
  if(index==NSNotFound) [records addObject:record]; else records[index]=record;
  return cuHostTrustSave(records);
}

static BOOL cuRevokeHost(NSString *publicKey) {
  if(!cuHostTrustPublicKey(publicKey)) return cuHostTrustFail(@"The selected host key is invalid.",errSecSuccess);
  if(!cuHostTrustLoad(!cuHostTrustReady)) return NO;
  NSMutableArray *records=[[cuHostTrustRecords mutableCopy] autorelease];
  NSUInteger index=[records indexOfObjectPassingTest:^BOOL(NSDictionary *record,NSUInteger i,BOOL *stop) { return [record[@"publicKey"] isEqual:publicKey]; }];
  if(index==NSNotFound) return cuHostTrustFail(@"The selected host is no longer stored.",errSecSuccess);
  NSMutableDictionary *record=[[records[index] mutableCopy] autorelease]; record[@"decision"]=@"revoked"; records[index]=record;
  return cuHostTrustSave(records);
}

static BOOL cuHostExclusions(NSString *publicKey,NSArray *keys) {
  if(!cuHostTrustPublicKey(publicKey) || ![keys isKindOfClass:NSArray.class] || keys.count>128) return cuHostTrustFail(@"Computer Use refused invalid excluded apps.",errSecSuccess);
  for(id key in keys) if(!cuHostTrustExclusion(key)) return cuHostTrustFail(@"Computer Use refused an unstable excluded app identifier.",errSecSuccess);
  if(!cuHostTrustLoad(!cuHostTrustReady)) return NO;
  NSMutableArray *records=[[cuHostTrustRecords mutableCopy] autorelease];
  NSUInteger index=[records indexOfObjectPassingTest:^BOOL(NSDictionary *record,NSUInteger i,BOOL *stop) { return [record[@"publicKey"] isEqual:publicKey]; }];
  if(index==NSNotFound) return cuHostTrustFail(@"Excluded apps could not be saved because the host is not stored.",errSecSuccess);
  NSMutableDictionary *record=[[records[index] mutableCopy] autorelease];
  NSMutableSet *excluded=[NSMutableSet setWithArray:record[@"exclusions"]]; [excluded addObjectsFromArray:keys];
  record[@"exclusions"]=[[excluded allObjects] sortedArrayUsingSelector:@selector(compare:)]; records[index]=record;
  return cuHostTrustSave(records);
}

static BOOL cuClearHostExclusions(NSString *publicKey) {
  if(!cuHostTrustPublicKey(publicKey)) return cuHostTrustFail(@"The selected host key is invalid.",errSecSuccess);
  if(!cuHostTrustLoad(!cuHostTrustReady)) return NO;
  NSMutableArray *records=[[cuHostTrustRecords mutableCopy] autorelease];
  NSUInteger index=[records indexOfObjectPassingTest:^BOOL(NSDictionary *record,NSUInteger i,BOOL *stop) { return [record[@"publicKey"] isEqual:publicKey]; }];
  if(index==NSNotFound) return cuHostTrustFail(@"The selected host is no longer stored.",errSecSuccess);
  NSMutableDictionary *record=[[records[index] mutableCopy] autorelease]; record[@"exclusions"]=@[]; records[index]=record;
  return cuHostTrustSave(records);
}
