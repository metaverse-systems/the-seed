#include <stdio.h>

#ifdef WITH_LIBRARY
const char *tiny_relinked_greeting(void);
#endif

int main(void)
{
#ifdef WITH_LIBRARY
    puts(tiny_relinked_greeting());
#else
    puts("tiny ok");
#endif
    return 0;
}
