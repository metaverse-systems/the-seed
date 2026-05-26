#include <SKELETON.hpp>

SKELETON_::SKELETON_():
  System("SCOPE/SKELETON") 
{ 
}

SKELETON_::SKELETON_(nlohmann::json config):
  System("SCOPE/SKELETON") 
{
}

nlohmann::json SKELETON_::Export() const
{
    nlohmann::json config;
    return config;
}

void SKELETON_::Initialize()
{
}

void SKELETON_::Shutdown()
{
}

void SKELETON_::Update()
{
    auto dt = this->DeltaTimeGet();
    // It's been dt milliseconds since the last Update()
    // Do some work
}

extern "C"
{
    ecs::System *create_system(void *p)
    {
        if(p == nullptr) return new SKELETON_();

        nlohmann::json *config = (nlohmann::json *)p;
        return new SKELETON_(*config);
    }
}
