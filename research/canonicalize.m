// Prints macOS News's canonical form of each URL read from stdin, as
// "input<TAB>canonical". Used to check owl.js's owlCanonicalize against Apple's.
//
//   clang -fobjc-arc -framework Foundation research/canonicalize.m -o canonicalize
//   printf 'https://WWW.Wired.com/story/x/?utm=1\n' | ./canonicalize

#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <dlfcn.h>

int main(void) {
    @autoreleasepool {
        dlopen("/System/Library/PrivateFrameworks/NewsURLBucket.framework/NewsURLBucket", RTLD_NOW);
        id canonicalizer = [NSClassFromString(@"NBURLCanonicalizer") new];
        char line[8192];
        while (fgets(line, sizeof line, stdin)) {
            line[strcspn(line, "\n")] = 0;
            NSURL *url = [NSURL URLWithString:@(line)];
            NSURL *canonical = url ? ((id (*)(id, SEL, id))objc_msgSend)(canonicalizer, NSSelectorFromString(@"canonicalizedURLForURL:"), url) : nil;
            printf("%s\t%s\n", line, canonical ? canonical.absoluteString.UTF8String : "(nil)");
        }
    }
    return 0;
}
